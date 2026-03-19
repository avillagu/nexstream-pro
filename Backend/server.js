const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for development
app.use(cors());

// Temp directory for downloads
const TEMP_DIR = path.join(__dirname, 'temp');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Format selector for yt-dlp (max 720p, prefer mp4)
const FORMAT_SELECTOR = 'best[ext=mp4][height<=720]/best[ext=mp4]/best[height<=720]/best';

// FFmpeg configuration for WhatsApp-compatible MP4
const FFMPEG_ARGS = [
  '-i', 'pipe:0',
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-crf', '23',
  '-pix_fmt', 'yuv420p',
  '-profile:v', 'baseline',
  '-level', '3.1',
  '-c:a', 'aac',
  '-b:a', '128k',
  '-ac', '2',
  '-movflags', '+faststart',
  '-y'
];

/**
 * Helper function to clean up temp files
 */
function cleanupTempFile(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlink(filePath, (err) => {
      if (err) console.error(`Error cleaning up temp file: ${err.message}`);
    });
  }
}

/**
 * Helper function to kill child processes
 */
function killProcess(proc) {
  if (proc) {
    try {
      proc.kill('SIGKILL');
    } catch (e) {
      // Process already dead
    }
  }
}

/**
 * GET /api/ping - Health check
 */
app.get('/api/ping', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /api/proxy-thumb - Proxy for thumbnails (avoids CORS)
 */
app.get('/api/proxy-thumb', async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  const { spawn } = require('child_process');

  // Use curl to fetch the thumbnail and pipe to response
  const curl = spawn('curl', [
    '-L',
    '-s',
    '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    url
  ]);

  let headersSent = false;

  curl.stdout.on('data', (data) => {
    if (!headersSent) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      headersSent = true;
    }
    res.write(data);
  });

  curl.stderr.on('data', (data) => {
    console.error(`curl stderr: ${data.toString()}`);
  });

  curl.on('close', (code) => {
    if (code !== 0 && !headersSent) {
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Failed to fetch thumbnail' });
      }
    }
    if (headersSent) {
      res.end();
    }
  });

  // Handle client disconnect
  req.on('close', () => {
    killProcess(curl);
  });
});

/**
 * GET /api/info - Extract metadata using yt-dlp
 */
app.get('/api/info', (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // yt-dlp to extract JSON metadata
  const ytDlp = spawn('yt-dlp', [
    '--dump-json',
    '--no-warnings',
    '--no-playlist',
    url
  ]);

  let stdout = '';
  let stderr = '';

  ytDlp.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  ytDlp.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  ytDlp.on('close', (code) => {
    if (code !== 0) {
      return res.status(500).json({
        error: 'Failed to extract video information',
        details: stderr.trim()
      });
    }

    try {
      const info = JSON.parse(stdout.trim());

      // Extract platform from extractor field
      const platform = info.extractor || 'unknown';

      const response = {
        title: info.title || 'Unknown Title',
        thumbnail: info.thumbnail || null,
        duration: info.duration || null,
        platform: platform,
        url: url,
        uploader: info.uploader || null,
        view_count: info.view_count || null
      };

      res.json(response);
    } catch (parseError) {
      res.status(500).json({
        error: 'Failed to parse video information',
        details: parseError.message
      });
    }
  });

  // Handle client disconnect
  req.on('close', () => {
    killProcess(ytDlp);
  });
});

/**
 * GET /api/download - Download, convert and stream video as MP4
 */
app.get('/api/download', (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // Generate unique temp filename
  const tempId = crypto.randomBytes(16).toString('hex');
  const tempFile = path.join(TEMP_DIR, `${tempId}.mp4`);

  let ytDlp = null;
  let ffmpeg = null;
  let headersSent = false;
  let errorSent = false;

  const sendError = (message, details = null) => {
    if (errorSent) return;
    errorSent = true;

    // Kill processes
    killProcess(ytDlp);
    killProcess(ffmpeg);

    // Clean up temp file
    cleanupTempFile(tempFile);

    // Send error response if headers not sent
    if (!headersSent && !res.headersSent) {
      res.status(500).json({ error: message, details });
    }
  };

  // Start yt-dlp to download video to stdout
  ytDlp = spawn('yt-dlp', [
    '-f', FORMAT_SELECTOR,
    '--no-playlist',
    '--no-warnings',
    '-o', '-',
    url
  ]);

  // Start ffmpeg to transcode (using absolute path if necessary)
  const FFMPEG_BIN = 'ffmpeg';
  ffmpeg = spawn(FFMPEG_BIN, FFMPEG_ARGS);

  // Pipe yt-dlp stdout to ffmpeg stdin
  ytDlp.stdout.pipe(ffmpeg.stdin);

  // Handle yt-dlp errors
  ytDlp.stderr.on('data', (data) => {
    const stderrStr = data.toString();
    console.log(`yt-dlp: ${stderrStr.trim()}`);
  });

  ytDlp.on('error', (err) => {
    console.error('yt-dlp spawn error:', err.message);
    sendError('Failed to start video download', err.message);
  });

  ytDlp.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`yt-dlp exited with code ${code}`);
      // Don't send error here if ffmpeg already sent one
      if (!errorSent) {
        sendError('Video download failed', `yt-dlp exited with code ${code}`);
      }
    }
  });

  // Handle ffmpeg errors
  ffmpeg.stderr.on('data', (data) => {
    const stderrStr = data.toString();
    console.log(`ffmpeg: ${stderrStr.trim()}`);
  });

  ffmpeg.on('error', (err) => {
    console.error('ffmpeg spawn error:', err.message);
    sendError('Failed to start video conversion', err.message);
  });

  // ffmpeg outputs to temp file
  ffmpeg.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`ffmpeg exited with code ${code}`);
      sendError('Video conversion failed', `ffmpeg exited with code ${code}`);
      return;
    }

    // Check if file exists and has content
    if (!fs.existsSync(tempFile)) {
      sendError('Video file was not created');
      return;
    }

    const stats = fs.statSync(tempFile);
    if (stats.size === 0) {
      sendError('Video file is empty');
      return;
    }

    // Stream the file to the client
    if (!headersSent && !res.headersSent) {
      headersSent = true;
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Content-Disposition', `attachment; filename="video.mp4"`);
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }

    const readStream = fs.createReadStream(tempFile);

    readStream.on('data', (chunk) => {
      if (!res.write(chunk)) {
        readStream.pause();
      }
    });

    readStream.on('end', () => {
      res.end();
      // Clean up temp file after streaming completes
      cleanupTempFile(tempFile);
    });

    readStream.on('error', (err) => {
      console.error('Read stream error:', err.message);
      if (!errorSent) {
        sendError('Failed to stream video', err.message);
      }
    });

    res.on('drain', () => {
      readStream.resume();
    });
  });

  // Handle client disconnect
  req.on('close', () => {
    console.log('Client disconnected, cleaning up...');
    killProcess(ytDlp);
    killProcess(ffmpeg);
    // Delay cleanup to allow ffmpeg to finish writing
    setTimeout(() => {
      cleanupTempFile(tempFile);
    }, 1000);
  });

  // Handle response finish
  res.on('finish', () => {
    // Clean up temp file after response is fully sent
    setTimeout(() => {
      cleanupTempFile(tempFile);
    }, 2000);
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`NexStream Pro Backend running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/ping`);
});

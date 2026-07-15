const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'clips');
const ALLOWED_SEGMENT_SECONDS = [15, 30];
const DEFAULT_SEGMENT_SECONDS = 30;
const CLEANUP_AFTER_MS = 60 * 60 * 1000; // auto-delete clips 1 hour after they're generated
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500MB — raise/lower to fit your host's limits

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.use(cors());
app.use(express.static(path.join(__dirname, 'public'))); // serves index.html (the frontend)
app.use('/clips', express.static(OUTPUT_DIR));            // serves generated clip files

// Assign a job id before multer writes the file, so we can name it predictably
app.use('/api/split', (req, res, next) => {
  req.jobId = uuidv4();
  next();
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `${req.jobId}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

app.post('/api/split', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file uploaded. Expected form field name "video".' });
  }

  const jobId = req.jobId;
  const inputPath = req.file.path;
  const jobOutputDir = path.join(OUTPUT_DIR, jobId);
  fs.mkdirSync(jobOutputDir, { recursive: true });

  const requestedSeconds = parseInt(req.body.duration, 10);
  const SEGMENT_SECONDS = ALLOWED_SEGMENT_SECONDS.includes(requestedSeconds)
    ? requestedSeconds
    : DEFAULT_SEGMENT_SECONDS;

  const outputPattern = path.join(jobOutputDir, 'clip_%03d.mp4');

  // -c copy = fast, no re-encoding, but cut points snap to the nearest keyframe
  // (so clips may land a bit before/after exactly 30s depending on the source's keyframe interval).
  // For frame-exact 30s cuts, swap "-c copy" for "-c:v libx264 -c:a aac" — much slower, more CPU.
  const ffmpegArgs = [
    '-i', inputPath,
    '-c', 'copy',
    '-map', '0',
    '-segment_time', String(SEGMENT_SECONDS),
    '-f', 'segment',
    '-reset_timestamps', '1',
    outputPattern
  ];

  execFile('ffmpeg', ffmpegArgs, (error, stdout, stderr) => {
    fs.unlink(inputPath, () => {}); // remove the original upload either way

    if (error) {
      console.error('FFmpeg error:', stderr);
      return res.status(500).json({ error: 'Video processing failed', detail: String(stderr).slice(-500) });
    }

    let files;
    try {
      files = fs.readdirSync(jobOutputDir).filter(f => f.endsWith('.mp4')).sort();
    } catch (e) {
      return res.status(500).json({ error: 'Could not read generated clips' });
    }

    if (!files.length) {
      return res.status(500).json({ error: 'No clips were generated — is the uploaded file a valid video?' });
    }

    const clips = files.map((name, i) => {
      const startSec = i * SEGMENT_SECONDS;
      const endSec = startSec + SEGMENT_SECONDS; // the last clip may actually run shorter
      return {
        name,
        url: `/clips/${jobId}/${name}`,
        start: formatTime(startSec),
        end: formatTime(endSec)
      };
    });

    res.json({ jobId, clips });

    // Free tier disk is ephemeral anyway, but clean up proactively so long-running
    // instances (or local dev) don't fill up with old clips.
    setTimeout(() => {
      fs.rm(jobOutputDir, { recursive: true, force: true }, () => {});
    }, CLEANUP_AFTER_MS);
  });
});

// Friendly error message for oversized uploads instead of a raw stack trace
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large. Max size is ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.` });
  }
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error' });
});

function formatTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`SecCut server running on port ${PORT}`));

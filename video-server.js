const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { exec } = require('child_process');

// Check if we're in Vercel environment
const isVercel = process.env.VERCEL === '1';

// Configuration
const VIDEOS_FOLDER = isVercel ? '/tmp/videos' : path.join(__dirname, 'videos');
const THUMBNAILS_FOLDER = isVercel ? '/tmp/thumbnails' : path.join(__dirname, 'thumbnails');

// Create directories if they don't exist
if (!fs.existsSync(VIDEOS_FOLDER)) {
  fs.mkdirSync(VIDEOS_FOLDER, { recursive: true });
  console.log(`Created videos folder at: ${VIDEOS_FOLDER}`);
}

if (!fs.existsSync(THUMBNAILS_FOLDER)) {
  fs.mkdirSync(THUMBNAILS_FOLDER, { recursive: true });
  console.log(`Created thumbnails folder at: ${THUMBNAILS_FOLDER}`);
}

const app = express();
const port = process.env.PORT || 3000;

// Add middleware to parse JSON and URL-encoded bodies
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configure multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit for Vercel
  }
});

// Middleware to handle CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.header('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Check if FFmpeg is available for thumbnail extraction
function checkFFmpeg() {
  return new Promise((resolve) => {
    exec('ffmpeg -version', (error) => {
      resolve(!error);
    });
  });
}

// Extract thumbnail from video
function extractThumbnail(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    const command = `ffmpeg -i "${videoPath}" -ss 00:00:01 -vframes 1 -vf "scale=320:-1" "${outputPath}"`;
    
    exec(command, (error) => {
      if (error) {
        console.error('Error extracting thumbnail:', error);
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

// Get list of all videos
app.get('/api/videos', (req, res) => {
  try {
    const files = fs.readdirSync(VIDEOS_FOLDER);
    const videoFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v', '.3gp'].includes(ext);
    });
    
    const videos = videoFiles.map(file => {
      const stats = fs.statSync(path.join(VIDEOS_FOLDER, file));
      const name = path.basename(file, path.extname(file));
      const thumbnailPath = path.join(THUMBNAILS_FOLDER, `${name}.jpg`);
      const hasThumbnail = fs.existsSync(thumbnailPath);
      
      return {
        id: name,
        filename: file,
        displayName: name,
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        hasThumbnail: hasThumbnail,
        url: `/video/${name}`,
        thumbnailUrl: hasThumbnail ? `/thumbnail/${name}` : null
      };
    });
    
    res.json(videos);
  } catch (error) {
    console.error('Error reading videos directory:', error);
    res.status(500).json({ error: 'Failed to read videos directory' });
  }
});

// Check if a video name already exists
app.get('/api/check-name/:name', (req, res) => {
  try {
    const name = req.params.name;
    const files = fs.readdirSync(VIDEOS_FOLDER);
    const videoFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v', '.3gp'].includes(ext);
    });
    
    const existingNames = videoFiles.map(file => 
      path.basename(file, path.extname(file))
    );
    
    const exists = existingNames.includes(name);
    res.json({ exists });
  } catch (error) {
    console.error('Error checking name:', error);
    res.status(500).json({ error: 'Failed to check name' });
  }
});

// Rename video endpoint
app.put('/api/rename/:id', (req, res) => {
  try {
    const videoId = req.params.id;
    const newName = req.body.newName;
    
    if (!newName || newName.trim() === '') {
      return res.status(400).json({ error: 'New name is required' });
    }
    
    const videoPath = findVideoFile(videoId);
    if (!videoPath) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    const ext = path.extname(videoPath);
    const newPath = path.join(VIDEOS_FOLDER, `${newName.trim()}${ext}`);
    
    if (fs.existsSync(newPath)) {
      return res.status(409).json({ error: 'A video with this name already exists' });
    }
    
    fs.renameSync(videoPath, newPath);
    
    const oldThumbnailPath = path.join(THUMBNAILS_FOLDER, `${videoId}.jpg`);
    const newThumbnailPath = path.join(THUMBNAILS_FOLDER, `${newName.trim()}.jpg`);
    
    if (fs.existsSync(oldThumbnailPath)) {
      fs.renameSync(oldThumbnailPath, newThumbnailPath);
    }
    
    res.json({ 
      success: true, 
      newId: newName.trim(),
      newFilename: `${newName.trim()}${ext}`
    });
  } catch (error) {
    console.error('Error renaming video:', error);
    res.status(500).json({ error: 'Failed to rename video' });
  }
});

// Stream video file
app.get('/video/:id', async (req, res) => {
  try {
    const videoId = req.params.id;
    const videoPath = findVideoFile(videoId);
    
    if (!videoPath) {
      return res.status(404).send(`Video not found: ${videoId}`);
    }
    
    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;
    
    const ext = path.extname(videoPath).toLowerCase();
    let contentType = 'video/mp4';
    
    switch (ext) {
      case '.webm': contentType = 'video/webm'; break;
      case '.ogg': contentType = 'video/ogg'; break;
      case '.mov': contentType = 'video/quicktime'; break;
      case '.avi': contentType = 'video/x-msvideo'; break;
      case '.mkv': contentType = 'video/x-matroska'; break;
      case '.flv': contentType = 'video/x-flv'; break;
      case '.wmv': contentType = 'video/x-ms-wmv'; break;
      case '.m4v': contentType = 'video/x-m4v'; break;
      case '.3gp': contentType = 'video/3gpp'; break;
    }
    
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(videoPath, { start, end });
      
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
      };
      
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': contentType,
      };
      
      res.writeHead(200, head);
      fs.createReadStream(videoPath).pipe(res);
    }
  } catch (error) {
    console.error('Error streaming video:', error);
    res.status(500).send(`Error streaming video: ${error.message}`);
  }
});

function findVideoFile(videoId) {
  try {
    const files = fs.readdirSync(VIDEOS_FOLDER);
    const videoFile = files.find(file => {
      const name = path.basename(file, path.extname(file));
      return name === videoId;
    });
    
    if (videoFile) {
      return path.join(VIDEOS_FOLDER, videoFile);
    }
    return null;
  } catch (error) {
    console.error('Error finding video file:', error);
    return null;
  }
}

app.get('/thumbnail/:id', (req, res) => {
  try {
    const thumbnailId = req.params.id;
    const thumbnailPath = path.join(THUMBNAILS_FOLDER, `${thumbnailId}.jpg`);
    
    if (fs.existsSync(thumbnailPath)) {
      res.sendFile(thumbnailPath);
    } else {
      res.status(404).send('Thumbnail not found');
    }
  } catch (error) {
    console.error('Error serving thumbnail:', error);
    res.status(500).send('Error serving thumbnail');
  }
});

app.post('/api/upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }
    
    const customName = req.body.customName;
    const originalExt = path.extname(req.file.originalname);
    
    let finalFilename;
    if (customName && customName.trim() !== '') {
      finalFilename = customName.trim() + originalExt;
    } else {
      finalFilename = req.file.originalname;
    }
    
    let counter = 1;
    let baseName = customName && customName.trim() !== '' ? customName.trim() : path.basename(req.file.originalname, originalExt);
    let filenameToUse = finalFilename;
    
    while (fs.existsSync(path.join(VIDEOS_FOLDER, filenameToUse))) {
      filenameToUse = `${baseName}_${counter}${originalExt}`;
      counter++;
    }
    
    const videoPath = path.join(VIDEOS_FOLDER, filenameToUse);
    fs.writeFileSync(videoPath, req.file.buffer);
    
    const videoId = path.basename(filenameToUse, path.extname(filenameToUse));
    
    const hasFFmpeg = await checkFFmpeg();
    if (hasFFmpeg) {
      try {
        const thumbnailPath = path.join(THUMBNAILS_FOLDER, `${videoId}.jpg`);
        await extractThumbnail(videoPath, thumbnailPath);
        console.log(`Thumbnail extracted for ${videoId}`);
      } catch (error) {
        console.error('Failed to extract thumbnail:', error);
      }
    }
    
    res.json({ 
      success: true, 
      videoId, 
      filename: filenameToUse,
      url: `/video/${videoId}`,
      thumbnailUrl: `/thumbnail/${videoId}`
    });
  } catch (error) {
    console.error('Error uploading video:', error);
    res.status(500).json({ error: 'Failed to upload video' });
  }
});

app.post('/api/upload-thumbnail', upload.single('thumbnail'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No thumbnail file uploaded' });
    }
    
    const videoId = req.body.videoId;
    if (!videoId) {
      return res.status(400).json({ error: 'Video ID is required' });
    }
    
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext !== '.jpg' && ext !== '.jpeg' && ext !== '.png') {
      return res.status(400).json({ error: 'Thumbnail must be a JPG or PNG image' });
    }
    
    const thumbnailPath = path.join(THUMBNAILS_FOLDER, `${videoId}.jpg`);
    fs.writeFileSync(thumbnailPath, req.file.buffer);
    
    res.json({ 
      success: true, 
      thumbnailUrl: `/thumbnail/${videoId}`
    });
  } catch (error) {
    console.error('Error uploading thumbnail:', error);
    res.status(500).json({ error: 'Failed to upload thumbnail' });
  }
});

app.delete('/api/video/:id', (req, res) => {
  try {
    const videoId = req.params.id;
    const videoPath = findVideoFile(videoId);
    
    if (!videoPath) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    fs.unlinkSync(videoPath);
    
    const thumbnailPath = path.join(THUMBNAILS_FOLDER, `${videoId}.jpg`);
    if (fs.existsSync(thumbnailPath)) {
      fs.unlinkSync(thumbnailPath);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting video:', error);
    res.status(500).json({ error: 'Failed to delete video' });
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Video Server</title>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background-color: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        h1 { color: #1976d2; }
        .video-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; margin-top: 20px; }
        .video-card { background-color: #f9f9f9; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); transition: transform 0.2s; }
        .video-card:hover { transform: translateY(-5px); }
        .video-thumbnail-container { width: 100%; height: 180px; position: relative; overflow: hidden; background-color: #ddd; }
        .video-thumbnail { width: 100%; height: 100%; object-fit: cover; }
        .video-info { padding: 15px; }
        .video-title { font-weight: bold; margin-bottom: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 1.1em; }
        .video-filename { font-size: 0.9em; color: #666; margin-bottom: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .video-meta { font-size: 0.9em; color: #666; }
        .video-actions { display: flex; justify-content: space-between; margin-top: 10px; flex-wrap: wrap; gap: 5px; }
        .btn { background-color: #1976d2; color: white; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; text-decoration: none; display: inline-block; font-size: 0.9em; flex: 1; min-width: 80px; text-align: center; }
        .btn:hover { background-color: #1565c0; }
        .btn-secondary { background-color: #757575; }
        .btn-secondary:hover { background-color: #616161; }
        .btn-danger { background-color: #f44336; }
        .btn-danger:hover { background-color: #d32f2f; }
        .upload-area { border: 2px dashed #ccc; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 20px; }
        .upload-area.dragover { border-color: #1976d2; background-color: #e3f2fd; }
        .hidden { display: none; }
        .video-player-container { margin-top: 20px; }
        video { width: 100%; max-height: 500px; }
        .notification { position: fixed; top: 20px; right: 20px; padding: 15px; background-color: #4caf50; color: white; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.2); z-index: 1000; opacity: 0; transition: opacity 0.3s; }
        .notification.show { opacity: 1; }
        .notification.error { background-color: #f44336; }
        .modal { display: none; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.5); }
        .modal-content { background-color: white; margin: 15% auto; padding: 20px; border-radius: 8px; width: 80%; max-width: 500px; }
        .close { color: #aaa; float: right; font-size: 28px; font-weight: bold; cursor: pointer; }
        .close:hover { color: black; }
        .form-group { margin-bottom: 15px; }
        .form-group label { display: block; margin-bottom: 5px; font-weight: bold; }
        .form-group input { width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ddd; border-radius: 4px; }
        .error-message { color: #f44336; font-size: 0.9em; margin-top: 5px; }
        .thumbnail-preview { width: 100px; height: 60px; object-fit: cover; margin-top: 10px; }
        .lazy-load { background-color: #f0f0f0; display: flex; align-items: center; justify-content: center; color: #666; width: 100%; height: 100%; }
        .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 20px; height: 20px; animation: spin 2s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .popup-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0, 0, 0, 0.5); display: flex; justify-content: center; align-items: center; z-index: 2000; opacity: 0; visibility: hidden; transition: opacity 0.3s, visibility 0.3s; }
        .popup-overlay.show { opacity: 1; visibility: visible; }
        .popup { background-color: white; border-radius: 8px; padding: 25px; max-width: 400px; width: 90%; box-shadow: 0 5px 15px rgba(0, 0, 0, 0.3); transform: scale(0.7); transition: transform 0.3s; }
        .popup-overlay.show .popup { transform: scale(1); }
        .popup-title { font-size: 1.5em; margin-bottom: 15px; color: #333; }
        .popup-message { margin-bottom: 20px; color: #666; }
        .popup-buttons { display: flex; justify-content: flex-end; gap: 10px; }
        .popup-btn { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 1em; transition: background-color 0.2s; }
        .popup-btn-confirm { background-color: #f44336; color: white; }
        .popup-btn-confirm:hover { background-color: #d32f2f; }
        .popup-btn-cancel { background-color: #e0e0e0; color: #333; }
        .popup-btn-cancel:hover { background-color: #d0d0d0; }
        @media (max-width: 768px) {
          .container { padding: 10px; }
          .video-grid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
          .video-actions { flex-direction: column; gap: 5px; }
          .btn { width: 100%; text-align: center; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Video Server</h1>
        
        <div class="upload-area" id="uploadArea">
          <p>Drag and drop video files here or click to select</p>
          <input type="file" id="fileInput" accept="video/*" multiple class="hidden">
        </div>
        
        <div id="videoPlayerContainer" class="video-player-container hidden">
          <h2>Now Playing: <span id="currentVideoTitle"></span></h2>
          <video id="videoPlayer" controls></video>
          <div style="margin-top: 10px;">
            <button id="closePlayer" class="btn btn-secondary">Close Player</button>
          </div>
        </div>
        
        <h2>Video Library</h2>
        <div id="videoGrid" class="video-grid">
          <!-- Videos will be loaded here -->
        </div>
      </div>
      
      <!-- Upload Modal -->
      <div id="uploadModal" class="modal">
        <div class="modal-content">
          <span class="close">&times;</span>
          <h2>Upload Video</h2>
          <form id="uploadForm" enctype="multipart/form-data">
            <div class="form-group">
              <label for="customName">Custom Name (optional):</label>
              <input type="text" id="customName" name="customName" placeholder="Leave blank to use original filename">
              <div id="nameError" class="error-message hidden"></div>
            </div>
            <div class="form-group">
              <label for="thumbnailFile">Thumbnail (optional):</label>
              <input type="file" id="thumbnailFile" accept="image/*">
              <img id="thumbnailPreview" class="thumbnail-preview hidden">
            </div>
            <div class="form-group">
              <button type="submit" class="btn">Upload</button>
              <button type="button" id="cancelUpload" class="btn btn-secondary">Cancel</button>
            </div>
          </form>
        </div>
      </div>
      
      <!-- Rename Modal -->
      <div id="renameModal" class="modal">
        <div class="modal-content">
          <span class="close">&times;</span>
          <h2>Rename Video</h2>
          <form id="renameForm">
            <div class="form-group">
              <label for="newName">New Name:</label>
              <input type="text" id="newName" name="newName" required>
              <div id="renameError" class="error-message hidden"></div>
            </div>
            <div class="form-group">
              <button type="submit" class="btn">Rename</button>
              <button type="button" id="cancelRename" class="btn btn-secondary">Cancel</button>
            </div>
          </form>
        </div>
      </div>
      
      <!-- Thumbnail Upload Modal -->
      <div id="thumbnailModal" class="modal">
        <div class="modal-content">
          <span class="close">&times;</span>
          <h2>Upload Thumbnail</h2>
          <form id="thumbnailForm" enctype="multipart/form-data">
            <div class="form-group">
              <label for="thumbnailFile2">Thumbnail Image:</label>
              <input type="file" id="thumbnailFile2" accept="image/*" required>
              <img id="thumbnailPreview2" class="thumbnail-preview hidden">
            </div>
            <div class="form-group">
              <button type="submit" class="btn">Upload</button>
              <button type="button" id="cancelThumbnail" class="btn btn-secondary">Cancel</button>
            </div>
          </form>
        </div>
      </div>
      
      <!-- Custom Popup -->
      <div id="popupOverlay" class="popup-overlay">
        <div class="popup">
          <h3 class="popup-title" id="popupTitle">Confirm Action</h3>
          <p class="popup-message" id="popupMessage">Are you sure you want to proceed?</p>
          <div class="popup-buttons">
            <button id="popupCancel" class="popup-btn popup-btn-cancel">Cancel</button>
            <button id="popupConfirm" class="popup-btn popup-btn-confirm">Confirm</button>
          </div>
        </div>
      </div>
      
      <div id="notification" class="notification"></div>
      
      <script>
        let currentVideoId = null;
        let videos = [];
        let pendingFiles = [];
        let popupCallback = null;
        
        async function loadVideos() {
          try {
            const response = await fetch('/api/videos');
            videos = await response.json();
            
            const videoGrid = document.getElementById('videoGrid');
            videoGrid.innerHTML = '';
            
            if (videos.length === 0) {
              videoGrid.innerHTML = '<p>No videos found. Upload some videos to get started!</p>';
              return;
            }
            
            videos.forEach(video => {
              const videoCard = document.createElement('div');
              videoCard.className = 'video-card';
              videoCard.dataset.videoId = video.id;
              
              const thumbnailContainer = document.createElement('div');
              thumbnailContainer.className = 'video-thumbnail-container';
              
              if (video.thumbnailUrl) {
                const lazyImage = document.createElement('img');
                lazyImage.className = 'video-thumbnail lazy-load';
                lazyImage.dataset.src = video.thumbnailUrl;
                lazyImage.alt = video.displayName;
                
                thumbnailContainer.innerHTML = '<div class="spinner"></div>';
                thumbnailContainer.appendChild(lazyImage);
                
                const observer = new IntersectionObserver((entries, observer) => {
                  entries.forEach(entry => {
                    if (entry.isIntersecting) {
                      const img = entry.target;
                      img.src = img.dataset.src;
                      img.onload = () => {
                        img.classList.remove('lazy-load');
                        thumbnailContainer.querySelector('.spinner')?.remove();
                      };
                      observer.unobserve(img);
                    }
                  });
                });
                
                observer.observe(lazyImage);
              } else {
                thumbnailContainer.innerHTML = '<div class="lazy-load">No Thumbnail</div>';
              }
              
              videoCard.appendChild(thumbnailContainer);
              
              const videoInfo = document.createElement('div');
              videoInfo.className = 'video-info';
              videoInfo.innerHTML = \`
                <div class="video-title" title="\${video.displayName}">\${video.displayName}</div>
                <div class="video-filename" title="\${video.filename}">\${video.filename}</div>
                <div class="video-meta">
                  Size: \${formatFileSize(video.size)}<br>
                  Modified: \${new Date(video.modified).toLocaleDateString()}
                </div>
                <div class="video-actions">
                  <button class="btn" onclick="playVideo('\${video.id}', '\${video.displayName}')">Play</button>
                  <button class="btn btn-secondary" onclick="showRenameModal('\${video.id}', '\${video.displayName}')">Rename</button>
                  <button class="btn btn-secondary" onclick="showThumbnailModal('\${video.id}')">Thumbnail</button>
                  <a href="\${video.url}" target="_blank" class="btn btn-secondary">Direct Link</a>
                  <button class="btn btn-danger" onclick="confirmDeleteVideo('\${video.id}')">Delete</button>
                </div>
              \`;
              
              videoCard.appendChild(videoInfo);
              videoGrid.appendChild(videoCard);
            });
          } catch (error) {
            console.error('Error loading videos:', error);
            showNotification('Failed to load videos', true);
          }
        }
        
        function playVideo(videoId, filename) {
          const player = document.getElementById('videoPlayer');
          const container = document.getElementById('videoPlayerContainer');
          const title = document.getElementById('currentVideoTitle');
          
          player.src = \`/video/\${videoId}\`;
          title.textContent = filename;
          container.classList.remove('hidden');
          
          player.play();
          container.scrollIntoView({ behavior: 'smooth' });
        }
        
        document.getElementById('closePlayer').addEventListener('click', function() {
          const player = document.getElementById('videoPlayer');
          const container = document.getElementById('videoPlayerContainer');
          
          player.pause();
          player.src = '';
          container.classList.add('hidden');
        });
        
        function showRenameModal(videoId, currentName) {
          currentVideoId = videoId;
          document.getElementById('newName').value = currentName;
          document.getElementById('renameError').classList.add('hidden');
          document.getElementById('renameModal').style.display = 'block';
        }
        
        async function renameVideo(videoId, newName) {
          try {
            const response = await fetch(\`/api/rename/\${videoId}\`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ newName })
            });
            
            if (response.ok) {
              showNotification('Video renamed successfully');
              loadVideos();
            } else {
              const error = await response.json();
              showNotification(\`Failed to rename video: \${error.error}\`, true);
            }
          } catch (error) {
            console.error('Error renaming video:', error);
            showNotification('Error renaming video', true);
          }
        }
        
        function confirmDeleteVideo(videoId) {
          showCustomPopup(
            'Delete Video',
            'Are you sure you want to delete this video? This action cannot be undone.',
            () => deleteVideo(videoId)
          );
        }
        
        async function deleteVideo(videoId) {
          try {
            const response = await fetch(\`/api/video/\${videoId}\`, {
              method: 'DELETE'
            });
            
            if (response.ok) {
              showNotification('Video deleted successfully');
              loadVideos();
            } else {
              showNotification('Failed to delete video', true);
            }
          } catch (error) {
            console.error('Error deleting video:', error);
            showNotification('Error deleting video', true);
          }
        }
        
        function formatFileSize(bytes) {
          if (bytes === 0) return '0 Bytes';
          const k = 1024;
          const sizes = ['Bytes', 'KB', 'MB', 'GB'];
          const i = Math.floor(Math.log(bytes) / Math.log(k));
          return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }
        
        function showNotification(message, isError = false) {
          const notification = document.getElementById('notification');
          notification.textContent = message;
          notification.className = 'notification show';
          if (isError) notification.classList.add('error');
          
          setTimeout(() => {
            notification.classList.remove('show');
          }, 3000);
        }
        
        function showCustomPopup(title, message, onConfirm, confirmText = 'Confirm', confirmClass = 'popup-btn-confirm') {
          const popupOverlay = document.getElementById('popupOverlay');
          const popupTitle = document.getElementById('popupTitle');
          const popupMessage = document.getElementById('popupMessage');
          const popupConfirm = document.getElementById('popupConfirm');
          
          popupTitle.textContent = title;
          popupMessage.textContent = message;
          popupConfirm.textContent = confirmText;
          popupConfirm.className = \`popup-btn \${confirmClass}\`;
          
          popupCallback = onConfirm;
          
          popupOverlay.classList.add('show');
        }
        
        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('fileInput');
        const uploadModal = document.getElementById('uploadModal');
        const uploadForm = document.getElementById('uploadForm');
        const customNameInput = document.getElementById('customName');
        const nameError = document.getElementById('nameError');
        const thumbnailFileInput = document.getElementById('thumbnailFile');
        const thumbnailPreview = document.getElementById('thumbnailPreview');
        
        uploadArea.addEventListener('click', () => fileInput.click());
        
        uploadArea.addEventListener('dragover', (e) => {
          e.preventDefault();
          uploadArea.classList.add('dragover');
        });
        
        uploadArea.addEventListener('dragleave', () => {
          uploadArea.classList.remove('dragover');
        });
        
        uploadArea.addEventListener('drop', (e) => {
          e.preventDefault();
          uploadArea.classList.remove('dragover');
          
          const files = Array.from(e.dataTransfer.files);
          handleFileSelection(files);
        });
        
        fileInput.addEventListener('change', () => {
          const files = Array.from(fileInput.files);
          handleFileSelection(files);
          fileInput.value = '';
        });
        
        function handleFileSelection(files) {
          const videoFiles = files.filter(file => file.type.startsWith('video/'));
          
          if (videoFiles.length === 0) {
            showNotification('No video files found in selection', true);
            return;
          }
          
          pendingFiles = videoFiles;
          uploadModal.style.display = 'block';
          
          uploadForm.reset();
          thumbnailPreview.classList.add('hidden');
          nameError.classList.add('hidden');
        }
        
        thumbnailFileInput.addEventListener('change', () => {
          const file = thumbnailFileInput.files[0];
          if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
              thumbnailPreview.src = e.target.result;
              thumbnailPreview.classList.remove('hidden');
            };
            reader.readAsDataURL(file);
          } else {
            thumbnailPreview.classList.add('hidden');
          }
        });
        
        customNameInput.addEventListener('input', async () => {
          const name = customNameInput.value.trim();
          if (name) {
            try {
              const response = await fetch(\`/api/check-name/\${encodeURIComponent(name)}\`);
              const result = await response.json();
              
              if (result.exists) {
                nameError.textContent = 'A video with this name already exists. Please choose a different name.';
                nameError.classList.remove('hidden');
              } else {
                nameError.classList.add('hidden');
              }
            } catch (error) {
              console.error('Error checking name:', error);
            }
          } else {
            nameError.classList.add('hidden');
          }
        });
        
        uploadForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          
          const customName = customNameInput.value.trim();
          const thumbnailFile = thumbnailFileInput.files[0];
          
          if (customName) {
            try {
              const response = await fetch(\`/api/check-name/\${encodeURIComponent(customName)}\`);
              const result = await response.json();
              
              if (result.exists) {
                nameError.textContent = 'A video with this name already exists. Please choose a different name.';
                nameError.classList.remove('hidden');
                return;
              }
            } catch (error) {
              console.error('Error checking name:', error);
            }
          }
          
          uploadModal.style.display = 'none';
          
          for (const file of pendingFiles) {
            try {
              showNotification(\`Uploading \${file.name}...\`);
              
              const formData = new FormData();
              formData.append('video', file);
              if (customName) {
                formData.append('customName', customName);
              }
              
              const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
              });
              
              if (response.ok) {
                const result = await response.json();
                showNotification(\`Successfully uploaded \${file.name}\`);
                
                if (thumbnailFile) {
                  try {
                    const thumbnailFormData = new FormData();
                    thumbnailFormData.append('thumbnail', thumbnailFile);
                    thumbnailFormData.append('videoId', result.videoId);
                    
                    const thumbnailResponse = await fetch('/api/upload-thumbnail', {
                      method: 'POST',
                      body: thumbnailFormData
                    });
                    
                    if (thumbnailResponse.ok) {
                      showNotification(\`Thumbnail uploaded for \${file.name}\`);
                    } else {
                      showNotification(\`Failed to upload thumbnail for \${file.name}\`, true);
                    }
                  } catch (error) {
                    console.error('Error uploading thumbnail:', error);
                    showNotification(\`Error uploading thumbnail for \${file.name}\`, true);
                  }
                }
              } else {
                showNotification(\`Failed to upload \${file.name}\`, true);
              }
            } catch (error) {
              console.error('Error uploading file:', error);
              showNotification(\`Error uploading \${file.name}\`, true);
            }
          }
          
          loadVideos();
        });
        
        document.getElementById('renameForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          
          const newName = document.getElementById('newName').value.trim();
          const renameError = document.getElementById('renameError');
          
          if (!newName) {
            renameError.textContent = 'Please enter a new name';
            renameError.classList.remove('hidden');
            return;
          }
          
          try {
            const response = await fetch(\`/api/check-name/\${encodeURIComponent(newName)}\`);
            const result = await response.json();
            
            if (result.exists) {
              renameError.textContent = 'A video with this name already exists. Please choose a different name.';
              renameError.classList.remove('hidden');
              return;
            } else {
              renameError.classList.add('hidden');
            }
          } catch (error) {
            console.error('Error checking name:', error);
          }
          
          document.getElementById('renameModal').style.display = 'none';
          await renameVideo(currentVideoId, newName);
        });
        
        document.querySelectorAll('.close').forEach(closeBtn => {
          closeBtn.addEventListener('click', function() {
            this.closest('.modal').style.display = 'none';
          });
        });
        
        document.getElementById('cancelUpload').addEventListener('click', () => {
          uploadModal.style.display = 'none';
        });
        
        document.getElementById('cancelRename').addEventListener('click', () => {
          document.getElementById('renameModal').style.display = 'none';
        });
        
        function showThumbnailModal(videoId) {
          currentVideoId = videoId;
          document.getElementById('thumbnailModal').style.display = 'block';
          document.getElementById('thumbnailForm').reset();
          document.getElementById('thumbnailPreview2').classList.add('hidden');
        }
        
        document.getElementById('cancelThumbnail').addEventListener('click', () => {
          document.getElementById('thumbnailModal').style.display = 'none';
        });
        
        document.getElementById('thumbnailFile2').addEventListener('change', () => {
          const file = document.getElementById('thumbnailFile2').files[0];
          if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
              document.getElementById('thumbnailPreview2').src = e.target.result;
              document.getElementById('thumbnailPreview2').classList.remove('hidden');
            };
            reader.readAsDataURL(file);
          } else {
            document.getElementById('thumbnailPreview2').classList.add('hidden');
          }
        });
        
        document.getElementById('thumbnailForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          
          const thumbnailFile = document.getElementById('thumbnailFile2').files[0];
          if (!thumbnailFile) {
            showNotification('Please select a thumbnail image', true);
            return;
          }
          
          try {
            const formData = new FormData();
            formData.append('thumbnail', thumbnailFile);
            formData.append('videoId', currentVideoId);
            
            const response = await fetch('/api/upload-thumbnail', {
              method: 'POST',
              body: formData
            });
            
            if (response.ok) {
              showNotification('Thumbnail uploaded successfully');
              document.getElementById('thumbnailModal').style.display = 'none';
              loadVideos();
            } else {
              showNotification('Failed to upload thumbnail', true);
            }
          } catch (error) {
            console.error('Error uploading thumbnail:', error);
            showNotification('Error uploading thumbnail', true);
          }
        });
        
        document.getElementById('popupCancel').addEventListener('click', () => {
          document.getElementById('popupOverlay').classList.remove('show');
          popupCallback = null;
        });
        
        document.getElementById('popupConfirm').addEventListener('click', () => {
          if (popupCallback) {
            popupCallback();
            popupCallback = null;
          }
          document.getElementById('popupOverlay').classList.remove('show');
        });
        
        window.addEventListener('click', (event) => {
          if (event.target.classList.contains('modal')) {
            event.target.style.display = 'none';
          }
        });
        
        loadVideos();
      </script>
    </body>
    </html>
  `);
});

// Export for Vercel
module.exports = app;
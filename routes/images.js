const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const sessionStore = require('../services/sessionStore');

const router = express.Router();

// Modified authentication for image requests - handles both header and query token
const authenticateImageRequest = (req, res, next) => {
  try {
    let token = null;
    
    // Try to get token from Authorization header first
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
    
    // If no header token, try query parameter (for direct image requests from browser)
    if (!token && req.query.token) {
      token = req.query.token;
    }
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const decoded = jwt.verify(token, process.env.SESSION_SECRET);
    req.user = { id: decoded.id, email: decoded.email, name: decoded.name };
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

router.get('/:filename', authenticateImageRequest, async (req, res) => {
  try {
    const { filename } = req.params;
    const userId = req.user.id;
    
    // Validate filename format
    const filenamePattern = /^page_\d+_[a-f0-9]+_\d+_[a-f0-9]+\.png$/;
    if (!filenamePattern.test(filename)) {
      return res.status(404).json({ error: 'Invalid image format' });
    }
    
    // Check if user has access to this image
    if (!sessionStore.validateImageAccess(userId, filename)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const tempImagesDir = path.join(__dirname, '..', 'temp_images');
    const imagePath = path.join(tempImagesDir, filename);
    
    // Ensure path is within temp_images directory
    const resolvedPath = path.resolve(imagePath);
    const allowedDir = path.resolve(tempImagesDir);
    
    if (!resolvedPath.startsWith(allowedDir)) {
      return res.status(403).json({ error: 'Invalid file path' });
    }
    
    if (!fs.existsSync(imagePath)) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    
    res.sendFile(imagePath);
    
  } catch (error) {
    console.error('Error in image route:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
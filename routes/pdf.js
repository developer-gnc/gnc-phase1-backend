const express = require('express');
const multer = require('multer');
const path = require('path');
const { requireAuth } = require('../middleware/auth');
const pdfController = require('../controllers/pdfController');

const router = express.Router();

// Configure multer with user-specific upload handling
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    // Include user ID and timestamp in filename to avoid conflicts
    const userId = req.user ? req.user.id : 'anonymous';
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    cb(null, `pdf_${userId}_${timestamp}${ext}`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// Apply authentication to all PDF processing routes
router.use(requireAuth);

// Process PDF with authentication
router.post('/process-pdf', upload.single('pdf'), pdfController.processPDF);

// Cancel processing with user validation
router.post('/cancel-processing', pdfController.cancelProcessing);

// Get active sessions for current user
router.get('/active-sessions', pdfController.getActiveSessions);

// Health check for PDF processing
router.get('/pdf-health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'PDF processing service is running',
    user: req.user.email,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
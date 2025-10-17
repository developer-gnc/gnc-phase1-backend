const express = require('express');
const multer = require('multer');
const pdfController = require('../controllers/pdfController');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

router.post('/process-pdf', upload.single('pdf'), pdfController.processPDF);

module.exports = router;
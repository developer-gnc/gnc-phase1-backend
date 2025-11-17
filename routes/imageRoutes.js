const express = require('express');
const { requireAuth } = require('../middleware/auth');
const imageController = require('../controllers/imageController');
const geminiService = require('../services/geminiService');

const router = express.Router();

// Apply authentication to all image processing routes
router.use(requireAuth);

// Process single image with page number, model, and optional custom prompt
router.post('/process-image', imageController.processImage);

// Process multiple images in batch
router.post('/process-batch-images', imageController.processBatchImages);

// Cancel processing
router.post('/cancel-processing', imageController.cancelProcessing);

// Get active sessions for current user
router.get('/active-sessions', imageController.getActiveSessions);

// Get system statistics
router.get('/system-stats', imageController.getSystemStats);

// Get available AI models
router.get('/available-models', (req, res) => {
  try {
    const models = [
      { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', description: 'Fast and efficient (Current)' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Faster with improved accuracy' },
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Most accurate, slower processing' }
    ];
    
    res.json({
      success: true,
      models: models,
      defaultModel: 'gemini-2.0-flash',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch available models',
      message: error.message
    });
  }
});

// Validate model
router.post('/validate-model', (req, res) => {
  try {
    const { model } = req.body;
    
    if (!model) {
      return res.status(400).json({
        error: 'Model name required',
        message: 'Please provide a model name to validate'
      });
    }
    
    const allowedModels = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'];
    const isValid = allowedModels.includes(model);
    
    res.json({
      success: true,
      model: model,
      isValid: isValid,
      availableModels: allowedModels,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to validate model',
      message: error.message
    });
  }
});

// Test single image analysis (for testing purposes)
router.post('/test-analyze', async (req, res) => {
  try {
    const { image, pageNumber = 1, model = 'gemini-2.0-flash', prompt } = req.body;
    
    if (!image) {
      return res.status(400).json({
        error: 'Image required',
        message: 'Please provide a base64 encoded image'
      });
    }
    
    if (!prompt) {
      return res.status(400).json({
        error: 'Prompt required',
        message: 'Please provide a prompt for data extraction'
      });
    }
    
    console.log(`Test analysis request from user: ${req.user.email}`);
    console.log(`Page: ${pageNumber}, Model: ${model}, Prompt from frontend: Yes`);
    
    const result = await geminiService.analyzeImage(
      image,
      pageNumber,
      model,
      prompt
    );
    
    res.json({
      success: true,
      pageNumber: pageNumber,
      model: model,
      promptUsed: true, // Always true since prompt is required from frontend
      extractedData: result.parsed,
      rawOutput: result.raw || JSON.stringify(result.parsed),
      error: result.error,
      extractedCount: result.parsed ? result.parsed.length : 0,
      processedBy: req.user.email,
      processedAt: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Test analysis error:', error);
    res.status(500).json({
      error: 'Analysis failed',
      message: error.message,
      processedBy: req.user.email,
      timestamp: new Date().toISOString()
    });
  }
});

// Health check for image processing service
router.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Image processing service is running',
    user: req.user.email,
    userId: req.user.id,
    timestamp: new Date().toISOString(),
    features: {
      singleImageProcessing: true,
      batchImageProcessing: true,
      modelSelection: true,
      promptFromFrontend: true, // Prompt must come from frontend
      userIsolation: true,
      parallelProcessing: true
    },
    availableModels: [
      { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', description: 'Fast and efficient (Current)' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Faster with improved accuracy' },
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Most accurate, slower processing' }
    ],
    endpoints: {
      processImage: 'POST /process-image',
      processBatch: 'POST /process-batch-images',
      availableModels: 'GET /available-models',
      testAnalyze: 'POST /test-analyze',
      health: 'GET /health'
    },
    requirements: {
      prompt: 'Required from frontend for all processing',
      model: 'Optional - defaults to gemini-2.0-flash',
      authentication: 'Required for all endpoints'
    }
  });
});

module.exports = router;
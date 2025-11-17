const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const geminiService = require('../services/geminiService');
const calculationService = require('../services/calculationService');
const sessionStore = require('../services/sessionStore');

// User-isolated processing sessions
const activeProcessingSessions = new Map();
const userProcessingQueues = new Map();

const getBaseURL = () => {
  return process.env.BACKEND_URL || 'http://localhost:5000';
};

const generateSessionId = (userId) => {
  return `session_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

// User isolation and parallel processing manager
class ImageProcessingManager {
  constructor() {
    this.maxConcurrentPerUser = 3;
    this.maxGlobalConcurrent = 15;
    this.globalActiveCount = 0;
  }

  canUserStartProcessing(userId) {
    const userQueue = userProcessingQueues.get(userId);
    const userActiveCount = userQueue ? userQueue.activeCount : 0;
    
    return (
      userActiveCount < this.maxConcurrentPerUser && 
      this.globalActiveCount < this.maxGlobalConcurrent
    );
  }

  startUserProcessing(userId, sessionId) {
    if (!userProcessingQueues.has(userId)) {
      userProcessingQueues.set(userId, { activeCount: 0, queue: [] });
    }
    
    const userQueue = userProcessingQueues.get(userId);
    userQueue.activeCount++;
    this.globalActiveCount++;
    
    console.log(`User ${userId} started processing. Active: ${userQueue.activeCount}/${this.maxConcurrentPerUser}, Global: ${this.globalActiveCount}/${this.maxGlobalConcurrent}`);
  }

  endUserProcessing(userId, sessionId) {
    const userQueue = userProcessingQueues.get(userId);
    if (userQueue && userQueue.activeCount > 0) {
      userQueue.activeCount--;
      this.globalActiveCount--;
      
      console.log(`User ${userId} ended processing. Active: ${userQueue.activeCount}/${this.maxConcurrentPerUser}, Global: ${this.globalActiveCount}/${this.maxGlobalConcurrent}`);
    }
  }

  getUserStats(userId) {
    const userQueue = userProcessingQueues.get(userId);
    return {
      activeCount: userQueue ? userQueue.activeCount : 0,
      maxAllowed: this.maxConcurrentPerUser,
      globalActive: this.globalActiveCount,
      globalMax: this.maxGlobalConcurrent
    };
  }
}

const processingManager = new ImageProcessingManager();

// Store and manage uploaded images
const imageStorage = new Map(); // sessionId -> { images: [], metadata: {} }

// Process single image with page number, model and custom prompt
exports.processImage = async (req, res) => {
  const userId = req.user.id;
  const userEmail = req.user.email;
  const sessionId = generateSessionId(userId);
  
  // Check user limits
  if (!processingManager.canUserStartProcessing(userId)) {
    const stats = processingManager.getUserStats(userId);
    return res.status(429).json({
      error: 'Processing limit reached',
      message: `User limit: ${stats.activeCount}/${stats.maxAllowed} active. Global: ${stats.globalActive}/${stats.globalMax} active. Please wait for current processing to complete.`,
      userStats: stats
    });
  }

  let shouldCancel = false;
  let isCleanedUp = false;

  const safeCleanup = (reason) => {
    if (!isCleanedUp) {
      console.log(`Cleanup triggered: ${reason}`);
      isCleanedUp = true;
      activeProcessingSessions.delete(sessionId);
      processingManager.endUserProcessing(userId, sessionId);
      imageStorage.delete(sessionId);
    }
  };

  try {
    // Extract data from request body
    const { 
      image, 
      pageNumber = 1, 
      model = 'gemini-2.0-flash',
      prompt // Required from frontend
    } = req.body;
   
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

    // Validate model
    const allowedModels = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'];
    if (!allowedModels.includes(model)) {
      return res.status(400).json({
        error: 'Invalid model',
        message: `Model must be one of: ${allowedModels.join(', ')}`
      });
    }

    // Start user processing
    processingManager.startUserProcessing(userId, sessionId);

    // Create session
    sessionStore.createSession(userId, sessionId, {
      userEmail: userEmail,
      startTime: Date.now(),
      model: model,
      prompt: prompt, // Store the prompt from frontend
      imageCount: 1
    });

    activeProcessingSessions.set(sessionId, {
      userId: userId,
      userEmail: userEmail,
      startTime: Date.now(),
      cancel: () => {
        shouldCancel = true;
        console.log(`Cancellation requested for session: ${sessionId} (User: ${userEmail})`);
      }
    });

    // Store image data
    imageStorage.set(sessionId, {
      images: [{
        base64: image,
        pageNumber: pageNumber,
        filename: `page_${pageNumber}_${crypto.randomBytes(8).toString('hex')}.png`
      }],
      metadata: {
        model: model,
        prompt: prompt, // Store prompt from frontend
        userId: userId,
        userEmail: userEmail
      }
    });

    console.log('\n' + '='.repeat(70));
    console.log('IMAGE PROCESSING REQUEST');
    console.log('='.repeat(70));
    console.log(`Session ID: ${sessionId}`);
    console.log(`User ID: ${userId}`);
    console.log(`User Email: ${userEmail}`);
    console.log(`Page Number: ${pageNumber}`);
    console.log(`Model: ${model}`);
    console.log(`Prompt from frontend: Yes`);
    console.log(`User Stats: ${JSON.stringify(processingManager.getUserStats(userId))}`);

    // Handle client disconnect
    req.on('close', () => {
      shouldCancel = true;
      safeCleanup('Client disconnect');
    });

    res.on('close', () => {
      shouldCancel = true;
      safeCleanup('Response close');
    });

    if (req.aborted || res.destroyed) {
      safeCleanup('Request aborted before start');
      return;
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Session-ID', sessionId);
    res.setHeader('X-User-ID', userId);

    // Send initial status
    res.write(`data: ${JSON.stringify({ 
      type: 'status', 
      sessionId: sessionId,
      userId: userId,
      userEmail: userEmail,
      pageNumber: pageNumber,
      model: model,
      userStats: processingManager.getUserStats(userId),
      message: `Starting image analysis for page ${pageNumber} using ${model}...` 
    })}\n\n`);

    if (shouldCancel) {
      safeCleanup('Cancelled before processing');
      return res.end();
    }

    console.log('\nSTARTING IMAGE ANALYSIS...');

    // Process the image
    let analysisResult;
    
    try {
      // Use prompt from frontend (required)
      analysisResult = await geminiService.analyzeImage(
        image, 
        pageNumber, 
        model,
        prompt
      );
    } catch (error) {
      console.error(`Error analyzing image:`, error);
      analysisResult = {
        parsed: [],
        raw: `Analysis Error: ${error.message}`,
        error: error.message
      };
    }

    if (shouldCancel) {
      safeCleanup('Cancelled during analysis');
      return res.end();
    }

    // Send analysis progress
    res.write(`data: ${JSON.stringify({ 
      type: 'analysis_complete',
      sessionId: sessionId,
      pageNumber: pageNumber,
      model: model,
      extractedCount: analysisResult.parsed ? analysisResult.parsed.length : 0,
      message: `Analysis complete for page ${pageNumber}. Found ${analysisResult.parsed ? analysisResult.parsed.length : 0} items.` 
    })}\n\n`);

    // Process extracted data using calculation service
    const pageResultWithPageNumber = calculationService.processPageData(analysisResult.parsed);

    // Add page number to all extracted items
    Object.keys(pageResultWithPageNumber).forEach(category => {
      pageResultWithPageNumber[category].forEach(item => {
        item.PAGE_NUMBER = pageNumber;
        item.SESSION_ID = sessionId;
        item.USER_ID = userId;
        item.MODEL_USED = model;
        item.PROMPT_USED = true; // Always true since prompt is required from frontend
      });
    });

    const processedData = {
      pageNumber: pageNumber,
      data: pageResultWithPageNumber,
      rawOutput: analysisResult.raw,
      error: analysisResult.error,
      userId: userId,
      sessionId: sessionId,
      model: model,
      promptUsed: true // Always true since prompt is required
    };

    // Prepare final result
    const finalResult = {
      labour: pageResultWithPageNumber.labour || [],
      material: pageResultWithPageNumber.material || [],
      equipment: pageResultWithPageNumber.equipment || [],
      consumables: pageResultWithPageNumber.consumables || [],
      subtrade: pageResultWithPageNumber.subtrade || [],
      labourTimesheet: pageResultWithPageNumber.labourTimesheet || [],
      equipmentLog: pageResultWithPageNumber.equipmentLog || []
    };

    const processingStats = {
      totalItems: Object.values(finalResult).reduce((sum, arr) => sum + arr.length, 0),
      pageNumber: pageNumber,
      modelUsed: model,
      promptUsed: true, // Always true since prompt is required from frontend
      extractedItems: analysisResult.parsed ? analysisResult.parsed.length : 0
    };

    console.log(`\nIMAGE PROCESSING COMPLETE for user ${userEmail}`);
    console.log(`Page: ${pageNumber}`);
    console.log(`Model used: ${model}`);
    console.log(`Processing Stats:`, processingStats);
    console.log(`Data Extracted:`);
    console.log(`- Labour items: ${finalResult.labour.length}`);
    console.log(`- Labour Timesheet items: ${finalResult.labourTimesheet.length}`);
    console.log(`- Material items: ${finalResult.material.length}`);
    console.log(`- Equipment items: ${finalResult.equipment.length}`);
    console.log(`- Equipment Log items: ${finalResult.equipmentLog.length}`);
    console.log(`- Consumables items: ${finalResult.consumables.length}`);
    console.log(`- Subtrade items: ${finalResult.subtrade.length}`);

    // Send final result
    res.write(`data: ${JSON.stringify({ 
      type: 'complete',
      sessionId: sessionId,
      pageData: processedData,
      collectedResult: finalResult,
      pageNumber: pageNumber,
      processedBy: userEmail,
      processedAt: new Date().toISOString(),
      modelUsed: model,
      promptUsed: true, // Always true since prompt is required from frontend
      userStats: processingManager.getUserStats(userId),
      processingStats: processingStats,
      message: `Processing complete for page ${pageNumber} using ${model}!`
    })}\n\n`);

    res.end();

  } catch (error) {
    console.error(`\nIMAGE PROCESSING ERROR for user ${userEmail}:`, error);
    
    if (!res.headersSent) {
      res.write(`data: ${JSON.stringify({ 
        type: 'error',
        sessionId: sessionId,
        error: error.message 
      })}\n\n`);
    }
    
    if (!res.destroyed) {
      res.end();
    }
  } finally {
    safeCleanup('Processing complete');
  }
};

// Process multiple images in batch
exports.processBatchImages = async (req, res) => {
  const userId = req.user.id;
  const userEmail = req.user.email;
  const sessionId = generateSessionId(userId);
  
  // Check user limits
  if (!processingManager.canUserStartProcessing(userId)) {
    const stats = processingManager.getUserStats(userId);
    return res.status(429).json({
      error: 'Processing limit reached',
      message: `User limit: ${stats.activeCount}/${stats.maxAllowed} active. Global: ${stats.globalActive}/${stats.globalMax} active. Please wait for current processing to complete.`,
      userStats: stats
    });
  }

  let shouldCancel = false;
  let isCleanedUp = false;

  const safeCleanup = (reason) => {
    if (!isCleanedUp) {
      console.log(`Cleanup triggered: ${reason}`);
      isCleanedUp = true;
      activeProcessingSessions.delete(sessionId);
      processingManager.endUserProcessing(userId, sessionId);
      imageStorage.delete(sessionId);
    }
  };

  try {
    const { 
      images, 
      model = 'gemini-2.0-flash',
      prompt // Required from frontend
    } = req.body;
  
console.log(`Received prompt from frontend (batch): "${prompt}"`);
    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({
        error: 'Images required',
        message: 'Please provide an array of images with pageNumber and base64 data'
      });
    }

    if (!prompt) {
      return res.status(400).json({
        error: 'Prompt required',
        message: 'Please provide a prompt for data extraction'
      });
    }

    // Validate model
    const allowedModels = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'];
    if (!allowedModels.includes(model)) {
      return res.status(400).json({
        error: 'Invalid model',
        message: `Model must be one of: ${allowedModels.join(', ')}`
      });
    }

    // Validate images array
    for (const img of images) {
      if (!img.image || !img.pageNumber) {
        return res.status(400).json({
          error: 'Invalid image data',
          message: 'Each image must have "image" (base64) and "pageNumber" fields'
        });
      }
    }

    // Start user processing
    processingManager.startUserProcessing(userId, sessionId);

    // Create session
    sessionStore.createSession(userId, sessionId, {
      userEmail: userEmail,
      startTime: Date.now(),
      model: model,
      prompt: prompt, // Store prompt from frontend
      imageCount: images.length
    });

    activeProcessingSessions.set(sessionId, {
      userId: userId,
      userEmail: userEmail,
      startTime: Date.now(),
      cancel: () => {
        shouldCancel = true;
        console.log(`Cancellation requested for session: ${sessionId} (User: ${userEmail})`);
      }
    });

    console.log('\n' + '='.repeat(70));
    console.log('BATCH IMAGE PROCESSING REQUEST');
    console.log('='.repeat(70));
    console.log(`Session ID: ${sessionId}`);
    console.log(`User ID: ${userId}`);
    console.log(`User Email: ${userEmail}`);
    console.log(`Total Images: ${images.length}`);
    console.log(`Model: ${model}`);
    console.log(`Prompt from frontend: Yes`);

    // Handle client disconnect
    req.on('close', () => {
      shouldCancel = true;
      safeCleanup('Client disconnect');
    });

    res.on('close', () => {
      shouldCancel = true;
      safeCleanup('Response close');
    });

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Session-ID', sessionId);
    res.setHeader('X-User-ID', userId);

    // Send initial status
    res.write(`data: ${JSON.stringify({ 
      type: 'status', 
      sessionId: sessionId,
      userId: userId,
      userEmail: userEmail,
      totalImages: images.length,
      model: model,
      userStats: processingManager.getUserStats(userId),
      message: `Starting batch analysis of ${images.length} images using ${model}...` 
    })}\n\n`);

    if (shouldCancel) {
      safeCleanup('Cancelled before processing');
      return res.end();
    }

    // Prepare images for analysis
    const imageData = images.map(img => ({
      base64: img.image,
      pageNumber: img.pageNumber
    }));

    // Process all images
    const analysisResults = await geminiService.analyzeImagesUltraFast(
      imageData,
      (completed, total, currentPage) => {
        if (!shouldCancel && !res.destroyed) {
          res.write(`data: ${JSON.stringify({ 
            type: 'analysis_progress',
            sessionId: sessionId,
            completed: completed,
            total: total,
            currentPage: currentPage,
            message: `Analyzed ${completed}/${total} images...`
          })}\n\n`);
        }
      },
      model,
      prompt // Pass prompt from frontend
    );

    if (shouldCancel) {
      safeCleanup('Cancelled during analysis');
      return res.end();
    }

    // Process results
    const allPagesData = [];
    const collectedResult = {
      labour: [],
      material: [],
      equipment: [],
      consumables: [],
      subtrade: [],
      labourTimesheet: [],
      equipmentLog: []
    };

    for (let i = 0; i < analysisResults.length; i++) {
      const result = analysisResults[i];
      const pageNumber = images[i].pageNumber;

      if (shouldCancel) break;

      // Process extracted data
      const pageResultWithPageNumber = calculationService.processPageData(result.parsed || []);

      // Add page number and metadata to all items
      Object.keys(pageResultWithPageNumber).forEach(category => {
        pageResultWithPageNumber[category].forEach(item => {
          item.PAGE_NUMBER = pageNumber;
          item.SESSION_ID = sessionId;
          item.USER_ID = userId;
          item.MODEL_USED = model;
          item.PROMPT_USED = true; // Always true since prompt is required from frontend
        });
      });

      const processedPageData = {
        pageNumber: pageNumber,
        data: pageResultWithPageNumber,
        rawOutput: result.raw,
        error: result.error,
        userId: userId,
        sessionId: sessionId,
        model: model,
        promptUsed: true // Always true since prompt is required
      };

      allPagesData.push(processedPageData);

      // Collect results
      Object.keys(collectedResult).forEach(category => {
        collectedResult[category].push(...(pageResultWithPageNumber[category] || []));
      });

      // Send page complete notification
      if (!shouldCancel && !res.destroyed) {
        res.write(`data: ${JSON.stringify({ 
          type: 'page_complete', 
          pageNumber: pageNumber,
          sessionId: sessionId,
          pageData: pageResultWithPageNumber,
          rawOutput: result.raw,
          error: result.error,
          message: result.error ? `Page ${pageNumber} completed with warnings` : `Page ${pageNumber} complete` 
        })}\n\n`);
      }
    }

    if (shouldCancel) {
      return res.end();
    }

    const processingStats = {
      totalImages: images.length,
      processedPages: allPagesData.length,
      successfulPages: allPagesData.filter(p => !p.error).length,
      errorPages: allPagesData.filter(p => p.error).length,
      modelUsed: model,
      promptUsed: true, // Always true since prompt is required from frontend
      totalItems: Object.values(collectedResult).reduce((sum, arr) => sum + arr.length, 0)
    };

    console.log(`\nBATCH PROCESSING COMPLETE for user ${userEmail}`);
    console.log(`Model used: ${model}`);
    console.log(`Processing Stats:`, processingStats);
    console.log(`Data Extracted:`);
    console.log(`- Labour items: ${collectedResult.labour.length}`);
    console.log(`- Labour Timesheet items: ${collectedResult.labourTimesheet.length}`);
    console.log(`- Material items: ${collectedResult.material.length}`);
    console.log(`- Equipment items: ${collectedResult.equipment.length}`);
    console.log(`- Equipment Log items: ${collectedResult.equipmentLog.length}`);
    console.log(`- Consumables items: ${collectedResult.consumables.length}`);
    console.log(`- Subtrade items: ${collectedResult.subtrade.length}`);

    // Send final result
    res.write(`data: ${JSON.stringify({ 
      type: 'complete',
      sessionId: sessionId,
      allPagesData: allPagesData,
      collectedResult: collectedResult,
      totalPages: images.length,
      processedBy: userEmail,
      processedAt: new Date().toISOString(),
      modelUsed: model,
      promptUsed: true, // Always true since prompt is required from frontend
      userStats: processingManager.getUserStats(userId),
      processingStats: processingStats,
      message: `Batch processing complete! ${images.length} images processed using ${model}.`
    })}\n\n`);

    res.end();

  } catch (error) {
    console.error(`\nBATCH PROCESSING ERROR for user ${userEmail}:`, error);
    
    if (!res.headersSent) {
      res.write(`data: ${JSON.stringify({ 
        type: 'error',
        sessionId: sessionId,
        error: error.message 
      })}\n\n`);
    }
    
    if (!res.destroyed) {
      res.end();
    }
  } finally {
    safeCleanup('Processing complete');
  }
};

// Cancel processing
exports.cancelProcessing = (req, res) => {
  const { sessionId } = req.body;
  const userId = req.user.id;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }
  
  const session = activeProcessingSessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found or already completed' });
  }
  
  if (session.userId !== userId) {
    return res.status(403).json({ error: 'Access denied: Cannot cancel another user\'s session' });
  }
  
  session.cancel();
  
  res.json({ 
    success: true, 
    message: 'Processing cancellation requested',
    sessionId,
    userId,
    userStats: processingManager.getUserStats(userId)
  });
};

// Get active sessions
exports.getActiveSessions = (req, res) => {
  const userId = req.user.id;
  const userSessions = sessionStore.getUserSessions(userId);
  
  res.json({ 
    activeSessions: userSessions,
    count: userSessions.length,
    userStats: processingManager.getUserStats(userId)
  });
};

// Get system stats
exports.getSystemStats = (req, res) => {
  const userId = req.user.id;
  
  res.json({
    userStats: processingManager.getUserStats(userId),
    globalStats: {
      activeUsers: userProcessingQueues.size,
      totalActiveSessions: processingManager.globalActiveCount,
      maxGlobalSessions: processingManager.maxGlobalConcurrent,
      systemLoad: Math.round((processingManager.globalActiveCount / processingManager.maxGlobalConcurrent) * 100)
    },
    timestamp: new Date().toISOString()
  });
};

// Cleanup on process exit
process.on('SIGTERM', async () => {
  console.log('Cleaning up all image sessions on process exit...');
  for (const [sessionId, session] of activeProcessingSessions.entries()) {
    processingManager.endUserProcessing(session.userId, sessionId);
    activeProcessingSessions.delete(sessionId);
    imageStorage.delete(sessionId);
  }
});

process.on('SIGINT', async () => {
  console.log('Cleaning up all image sessions on process interrupt...');
  for (const [sessionId, session] of activeProcessingSessions.entries()) {
    processingManager.endUserProcessing(session.userId, sessionId);
    activeProcessingSessions.delete(sessionId);
    imageStorage.delete(sessionId);
  }
  process.exit(0);
});
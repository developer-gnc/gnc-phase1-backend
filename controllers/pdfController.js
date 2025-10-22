const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pdfService = require('../services/pdfService');
const geminiService = require('../services/geminiService');
const calculationService = require('../services/calculationService');
const sessionStore = require('../services/sessionStore');

// ULTRA-FAST: User-isolated processing sessions
const activeProcessingSessions = new Map();
const userProcessingQueues = new Map();

const getBaseURL = () => {
  return process.env.BACKEND_URL || 'http://localhost:5000';
};

const generateSessionId = (userId) => {
  return `session_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

// User isolation and parallel processing manager
class UltraFastUserManager {
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

const userManager = new UltraFastUserManager();

const cleanupSession = (sessionId, pdfPath, userId, keepImages = false) => {
  console.log(`Cleaning up session: ${sessionId} for user: ${userId} (keepImages: ${keepImages})`);
  
  activeProcessingSessions.delete(sessionId);
  userManager.endUserProcessing(userId, sessionId);
  
  if (pdfPath && fs.existsSync(pdfPath)) {
    try {
      fs.unlinkSync(pdfPath);
      console.log(`Deleted PDF file: ${pdfPath}`);
    } catch (error) {
      console.error(`Error deleting PDF file:`, error.message);
    }
  }

  if (!keepImages) {
    try {
      pdfService.cleanupSessionImages(sessionId, userId);
    } catch (error) {
      console.log(`Warning: Could not clean session images: ${error.message}`);
    }
  }
};

// ROBUST: PDF processing with comprehensive error handling
exports.processPDF = async (req, res) => {
  let pdfPath = null;
  const baseURL = getBaseURL();
  const userId = req.user.id;
  const userEmail = req.user.email;
  const sessionId = generateSessionId(userId);
  
  // Check user limits
  if (!userManager.canUserStartProcessing(userId)) {
    const stats = userManager.getUserStats(userId);
    return res.status(429).json({
      error: 'Processing limit reached',
      message: `User limit: ${stats.activeCount}/${stats.maxAllowed} active. Global: ${stats.globalActive}/${stats.globalMax} active. Please wait for current processing to complete.`,
      userStats: stats
    });
  }
  
  let shouldCancel = false;
  let isCleanedUp = false;
  
  const safeCleanup = (reason, keepImages = true) => {
    if (!isCleanedUp) {
      console.log(`Cleanup triggered: ${reason} (keepImages: ${keepImages})`);
      isCleanedUp = true;
      cleanupSession(sessionId, pdfPath, userId, keepImages);
    }
  };
  
  try {
    pdfPath = req.file.path;
    
    // ROBUST: Validate PDF before processing
    try {
      await pdfService.validatePDF(pdfPath);
    } catch (validationError) {
      return res.status(400).json({
        error: 'PDF validation failed',
        message: validationError.message
      });
    }
    
    // Start user processing
    userManager.startUserProcessing(userId, sessionId);
    
    sessionStore.createSession(userId, sessionId, {
      userEmail: userEmail,
      pdfPath: pdfPath,
      startTime: Date.now(),
      imagesKeepAlive: Date.now() + (60 * 60 * 1000)
    });
    
    activeProcessingSessions.set(sessionId, {
      userId: userId,
      userEmail: userEmail,
      pdfPath,
      startTime: Date.now(),
      cancel: () => {
        shouldCancel = true;
        console.log(`Cancellation requested for session: ${sessionId} (User: ${userEmail})`);
      }
    });
    
    console.log('\n' + '='.repeat(70));
    console.log('ROBUST ULTRA-FAST PDF PROCESSING REQUEST');
    console.log('='.repeat(70));
    console.log(`Session ID: ${sessionId}`);
    console.log(`User ID: ${userId}`);
    console.log(`User Email: ${userEmail}`);
    console.log(`PDF: ${pdfPath}`);
    console.log(`User Stats: ${JSON.stringify(userManager.getUserStats(userId))}`);
    
    req.on('close', () => {
      shouldCancel = true;
      safeCleanup('Client disconnect', true);
    });
    
    res.on('close', () => {
      shouldCancel = true;
      safeCleanup('Response close', true);
    });
    
    if (req.aborted || res.destroyed) {
      safeCleanup('Request aborted before start', true);
      return;
    }
    
    const pageCount = await pdfService.getPDFPageCount(pdfPath);
    console.log(`Total pages: ${pageCount}`);
    
    if (shouldCancel) {
      safeCleanup('Cancelled after page count', true);
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Session-ID', sessionId);
    res.setHeader('X-User-ID', userId);

    res.write(`data: ${JSON.stringify({ 
      type: 'status', 
      totalPages: pageCount, 
      currentPage: 0,
      sessionId: sessionId,
      userId: userId,
      userEmail: userEmail,
      userStats: userManager.getUserStats(userId),
      message: `PDF validated successfully. Found ${pageCount} pages. Starting robust conversion...` 
    })}\n\n`);

    console.log('\nROBUST PHASE 1: Intelligent batch conversion with error recovery...');
    
    // ROBUST: Convert images with comprehensive error handling
    const OPTIMAL_BATCH_SIZE = Math.min(5, Math.max(2, Math.ceil(pageCount / 20))); // Conservative batching
    const allImages = [];
    let convertedCount = 0;
    let successfulCount = 0;
    let failedCount = 0;

    // Process batches with error tracking
    for (let i = 1; i <= pageCount; i += OPTIMAL_BATCH_SIZE) {
      if (shouldCancel) break;

      const batchEnd = Math.min(i + OPTIMAL_BATCH_SIZE - 1, pageCount);
      console.log(`Processing batch: pages ${i}-${batchEnd}`);
      
      const batchResult = await pdfService.convertPDFBatchToImages(
        pdfPath, 
        i, 
        batchEnd, 
        sessionId, 
        userId,
        (current, total, pageNumber) => {
          // Progress within batch
          convertedCount = i - 1 + current;
          
          if (!shouldCancel && !res.destroyed) {
            res.write(`data: ${JSON.stringify({ 
              type: 'conversion_progress',
              sessionId: sessionId,
              currentPage: convertedCount,
              totalPages: pageCount,
              phase: 'conversion',
              message: `Converting page ${convertedCount}/${pageCount}...`,
              pageNumber: pageNumber
            })}\n\n`);
          }
        }
      );

      // Update counters based on batch results
      successfulCount += batchResult.successCount;
      failedCount += batchResult.errorCount;

      // Collect all results (both successful and failed)
      allImages.push(...batchResult.results);

      // Send batch completion update with real-time streaming
      if (!shouldCancel && !res.destroyed) {
        try {
          res.write(`data: ${JSON.stringify({
            type: 'images_batch_ready',
            sessionId: sessionId,
            batchImages: batchResult.results.map(img => ({
              pageNumber: img.pageNumber,
              imageUrl: img.imageUrl,
              conversionError: img.conversionError,
              success: img.success
            })),
            totalConverted: convertedCount,
            totalPages: pageCount,
            successCount: successfulCount,
            failedCount: failedCount,
            conversionComplete: convertedCount >= pageCount,
            message: `Batch ${i}-${batchEnd} converted: ${batchResult.successCount} success, ${batchResult.errorCount} errors`
          })}\n\n`);
        } catch (writeError) {
          shouldCancel = true;
        }
      }

      // Small delay between batches for stability
      if (i + OPTIMAL_BATCH_SIZE <= pageCount && !shouldCancel) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    if (shouldCancel) {
      safeCleanup('Cancelled during conversion', true);
      return res.end();
    }

    console.log(`\nCONVERSION COMPLETE for user ${userEmail}`);
    console.log(`Successfully converted: ${successfulCount}/${pageCount} pages`);
    console.log(`Failed conversions: ${failedCount}/${pageCount} pages`);

    // Send final conversion complete message
    res.write(`data: ${JSON.stringify({
      type: 'images_ready',
      sessionId: sessionId,
      allImages: allImages.map(img => ({
        pageNumber: img.pageNumber,
        imageUrl: img.imageUrl,
        conversionError: img.conversionError,
        success: img.success
      })),
      totalPages: pageCount,
      successCount: successfulCount,
      failedCount: failedCount,
      conversionComplete: true,
      allConverted: true,
      message: `Conversion complete: ${successfulCount} pages ready for selection`
    })}\n\n`);

    // Keep connection open - user will select images and trigger second endpoint
    
  } catch (error) {
    console.error(`\nROBUST PROCESSING ERROR for user ${userEmail}:`, error);
    
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

// NEW: Process selected images with AI analysis (with MODEL SELECTION support)
exports.processSelectedImages = async (req, res) => {
  const baseURL = getBaseURL();
  const userId = req.user.id;
  const userEmail = req.user.email;
  const { selectedPageNumbers, sessionId, model } = req.body; // Extract model parameter
  
  // Use provided model or default to gemini-2.0-flash
  const selectedModel = model || 'gemini-2.0-flash';
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`AI ANALYSIS REQUEST`);
  console.log(`${'='.repeat(70)}`);
  console.log(`User: ${userEmail}`);
  console.log(`Session: ${sessionId}`);
  console.log(`Pages: ${selectedPageNumbers?.length || 0}`);
  console.log(`Model: ${selectedModel}`); // Log selected model
  console.log(`${'='.repeat(70)}\n`);
  
  let shouldCancel = false;
  let isCleanedUp = false;
  
  const safeCleanup = (reason) => {
    if (!isCleanedUp) {
      console.log(`Processing cleanup: ${reason}`);
      isCleanedUp = true;
      userManager.endUserProcessing(userId, sessionId);
    }
  };

  try {
    if (!selectedPageNumbers || selectedPageNumbers.length === 0) {
      return res.status(400).json({
        error: 'No pages selected',
        message: 'Please select at least one page to process'
      });
    }

    if (!sessionId || !sessionStore.validateUserSession(userId, sessionId)) {
      return res.status(403).json({
        error: 'Invalid session',
        message: 'Session expired or access denied'
      });
    }

    // Start user processing for AI analysis phase
    userManager.startUserProcessing(userId, sessionId);

    const session = activeProcessingSessions.get(sessionId);
    if (session) {
      session.cancel = () => {
        shouldCancel = true;
        console.log(`AI processing cancellation requested for session: ${sessionId}`);
      };
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Session-ID', sessionId);

    res.write(`data: ${JSON.stringify({ 
      type: 'status',
      sessionId: sessionId,
      model: selectedModel, // Include model in status
      message: `Starting AI analysis with ${selectedModel}...` // Show model in message
    })}\n\n`);

    req.on('close', () => {
      shouldCancel = true;
      safeCleanup('Client disconnect');
    });

    res.on('close', () => {
      shouldCancel = true;
      safeCleanup('Response close');
    });

    console.log(`\nROBUST PHASE 2: Loading images for selected pages (User: ${userEmail})`);
    console.log(`Selected pages: ${selectedPageNumbers.join(', ')}`);

    const tempImagesDir = path.join(__dirname, '..', 'temp_images');
    const selectedImages = [];

    // Load and validate selected images
    for (const pageNumber of selectedPageNumbers) {
      try {
        const timestamp = sessionId.split('_')[2];
        const userHash = crypto.createHash('sha256').update(userId).digest('hex').substring(0, 8);
        
        const imageFile = fs.readdirSync(tempImagesDir).find(file => 
          file.includes(`page_${pageNumber}_${userHash}_${timestamp}`) && 
          file.endsWith('.png')
        );
        
        if (imageFile) {
          const imagePath = path.join(tempImagesDir, imageFile);
          
          // Validate image file exists and is readable
          if (!fs.existsSync(imagePath)) {
            throw new Error('Image file not found after initial discovery');
          }
          
          const imageStats = fs.statSync(imagePath);
          if (imageStats.size === 0) {
            throw new Error('Image file is empty');
          }
          
          const imageBuffer = fs.readFileSync(imagePath);
          const base64 = imageBuffer.toString('base64');
          
          selectedImages.push({
            pageNumber: pageNumber,
            base64: `data:image/png;base64,${base64}`,
            imageUrl: `${baseURL}/images/${imageFile}`,
            success: true
          });
        } else {
          console.error(`Image file not found for page ${pageNumber} (user ${userId})`);
          selectedImages.push({
            pageNumber: pageNumber,
            base64: null,
            imageUrl: null,
            conversionError: 'Image file not found during processing - may have been cleaned up',
            success: false
          });
        }
      } catch (error) {
        console.error(`Error loading image for page ${pageNumber} (user ${userId}):`, error.message);
        selectedImages.push({
          pageNumber: pageNumber,
          base64: null,
          imageUrl: null,
          conversionError: error.message,
          success: false
        });
      }
    }

    // IMPROVED: Filter out failed conversions before sending to Gemini API
    const validImages = selectedImages.filter(img => {
      const hasValidData = img.base64 && img.imageUrl && !img.conversionError && img.success;
      if (!hasValidData) {
        console.log(`❌ Excluding page ${img.pageNumber} from AI analysis: ${img.conversionError || 'Invalid image data'}`);
      }
      return hasValidData;
    });
    
    if (validImages.length === 0) {
      return res.status(400).json({
        error: 'No valid images to process',
        message: 'All selected images failed conversion and cannot be processed by AI'
      });
    }

    console.log(`✅ Processing ${validImages.length} valid images out of ${selectedImages.length} selected`);
    console.log(`❌ Skipping ${selectedImages.length - validImages.length} failed conversions`);
    console.log(`🤖 Using model: ${selectedModel}`); // Log model being used

    // Initialize data collection
    const collectedResult = {
      labour: [], material: [], equipment: [], consumables: [], 
      subtrade: [], labourTimesheet: [], equipmentLog: []
    };
    const allPagesData = [];

    // ULTRA-FAST: AI processing with robust error handling - ONLY VALID IMAGES - WITH MODEL SELECTION
    const analysisResults = await geminiService.analyzeImagesUltraFast(
      validImages, // Only send successfully converted images to Gemini
      (completed, total, pageNumber) => {
        if (shouldCancel || req.aborted || res.destroyed) {
          return;
        }

        try {
          res.write(`data: ${JSON.stringify({ 
            type: 'progress',
            totalPages: total,
            currentPage: completed,
            phase: 'analysis',
            sessionId: sessionId,
            model: selectedModel, // Include model in progress updates
            message: `AI analysis (${selectedModel}): ${completed}/${total} pages complete...`, // Show model in progress
            pageNumber: pageNumber
          })}\n\n`);
        } catch (writeError) {
          shouldCancel = true;
        }
      },
      selectedModel // PASS THE SELECTED MODEL TO GEMINI SERVICE
    );

    if (shouldCancel || req.aborted || res.destroyed) {
      return res.end();
    }

    console.log(`\nROBUST PHASE 3: Processing and validating results...`);
    
    // Process results with validation - handle both valid and failed images
    for (let i = 0; i < selectedImages.length; i++) {
      const imageInfo = selectedImages[i];
      const pageNumber = imageInfo.pageNumber;

      // Handle failed conversions
      if (imageInfo.conversionError || !imageInfo.success) {
        const errorPageData = {
          pageNumber: pageNumber,
          data: { 
            labour: [], material: [], equipment: [], consumables: [], 
            subtrade: [], labourTimesheet: [], equipmentLog: []
          },
          rawOutput: `Conversion Error: ${imageInfo.conversionError}`,
          imageUrl: null,
          error: `Failed to load page: ${imageInfo.conversionError}`,
          userId: userId,
          sessionId: sessionId
        };

        allPagesData.push(errorPageData);

        if (!shouldCancel && !req.aborted && !res.destroyed) {
          try {
            res.write(`data: ${JSON.stringify({ 
              type: 'page_complete', 
              pageNumber: pageNumber,
              sessionId: sessionId,
              pageData: errorPageData.data,
              rawOutput: errorPageData.rawOutput,
              imageUrl: errorPageData.imageUrl,
              error: errorPageData.error,
              message: `Page ${pageNumber} skipped (conversion error)` 
            })}\n\n`);
          } catch (writeError) {
            shouldCancel = true;
          }
        }
        continue;
      }

      // Handle successfully processed images
      const resultIndex = validImages.findIndex(img => img.pageNumber === pageNumber);
      if (resultIndex === -1) {
        console.error(`Analysis result not found for page ${pageNumber}`);
        continue;
      }
      
      const analysisResult = analysisResults[resultIndex];

      try {
        const pageResult = calculationService.processPageData(analysisResult.parsed);
        
        // Add page number and user isolation to all items
        const pageResultWithPageNumber = {
          labour: pageResult.labour.map(item => ({ ...item, pageNumber, userId, sessionId })),
          material: pageResult.material.map(item => ({ ...item, pageNumber, userId, sessionId })),
          equipment: pageResult.equipment.map(item => ({ ...item, pageNumber, userId, sessionId })),
          consumables: pageResult.consumables.map(item => ({ ...item, pageNumber, userId, sessionId })),
          subtrade: pageResult.subtrade.map(item => ({ ...item, pageNumber, userId, sessionId })),
          labourTimesheet: pageResult.labourTimesheet.map(item => ({ ...item, pageNumber, userId, sessionId })),
          equipmentLog: pageResult.equipmentLog.map(item => ({ ...item, pageNumber, userId, sessionId }))
        };

        const processedPageData = {
          pageNumber: pageNumber,
          data: pageResultWithPageNumber,
          rawOutput: analysisResult.raw,
          imageUrl: imageInfo.imageUrl,
          error: analysisResult.error,
          userId: userId,
          sessionId: sessionId
        };

        allPagesData.push(processedPageData);

        // Add to collected results with user isolation
        collectedResult.labour.push(...pageResultWithPageNumber.labour);
        collectedResult.material.push(...pageResultWithPageNumber.material);
        collectedResult.equipment.push(...pageResultWithPageNumber.equipment);
        collectedResult.consumables.push(...pageResultWithPageNumber.consumables);
        collectedResult.subtrade.push(...pageResultWithPageNumber.subtrade);
        collectedResult.labourTimesheet.push(...pageResultWithPageNumber.labourTimesheet);
        collectedResult.equipmentLog.push(...pageResultWithPageNumber.equipmentLog);

        if (!shouldCancel && !req.aborted && !res.destroyed) {
          try {
            res.write(`data: ${JSON.stringify({ 
              type: 'page_complete', 
              pageNumber: pageNumber,
              sessionId: sessionId,
              pageData: pageResultWithPageNumber,
              rawOutput: analysisResult.raw,
              imageUrl: imageInfo.imageUrl,
              error: analysisResult.error,
              message: analysisResult.error ? `Page ${pageNumber} completed with warnings` : `Page ${pageNumber} complete` 
            })}\n\n`);
          } catch (writeError) {
            shouldCancel = true;
          }
        }
      } catch (processingError) {
        console.error(`Error processing results for page ${pageNumber}:`, processingError.message);
        
        const errorPageData = {
          pageNumber: pageNumber,
          data: { 
            labour: [], material: [], equipment: [], consumables: [], 
            subtrade: [], labourTimesheet: [], equipmentLog: []
          },
          rawOutput: `Processing Error: ${processingError.message}`,
          imageUrl: imageInfo.imageUrl,
          error: `Failed to process results: ${processingError.message}`,
          userId: userId,
          sessionId: sessionId
        };

        allPagesData.push(errorPageData);
      }
    }

    allPagesData.sort((a, b) => a.pageNumber - b.pageNumber);
    
    if (shouldCancel || req.aborted || res.destroyed) {
      return res.end();
    }
    
    const processingStats = {
      totalSelected: selectedPageNumbers.length,
      validImages: validImages.length,
      processedPages: allPagesData.length,
      successfulPages: allPagesData.filter(p => !p.error).length,
      errorPages: allPagesData.filter(p => p.error).length,
      modelUsed: selectedModel // Include model in stats
    };
    
    console.log(`\nROBUST PROCESSING COMPLETE for user ${userEmail}`);
    console.log(`Model used: ${selectedModel}`); // Log model used
    console.log(`Processing Stats:`, processingStats);
    console.log(`Data Extracted:`);
    console.log(`- Labour items: ${collectedResult.labour.length}`);
    console.log(`- Labour Timesheet items: ${collectedResult.labourTimesheet.length}`);
    console.log(`- Material items: ${collectedResult.material.length}`);
    console.log(`- Equipment items: ${collectedResult.equipment.length}`);
    console.log(`- Equipment Log items: ${collectedResult.equipmentLog.length}`);
    console.log(`- Consumables items: ${collectedResult.consumables.length}`);
    console.log(`- Subtrade items: ${collectedResult.subtrade.length}`);
    
    res.write(`data: ${JSON.stringify({ 
      type: 'complete',
      sessionId: sessionId,
      allPagesData: allPagesData,
      collectedResult: collectedResult,
      totalPages: selectedPageNumbers.length,
      processedBy: userEmail,
      processedAt: new Date().toISOString(),
      modelUsed: selectedModel, // Include model in completion data
      userStats: userManager.getUserStats(userId),
      processingStats: processingStats,
      message: `Processing complete with ${selectedModel}!` // Show model in completion message
    })}\n\n`);

    res.end();
    
  } catch (error) {
    console.error(`\nROBUST PROCESSING ERROR for user ${userEmail}:`, error);
    
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

// Keep other functions unchanged but add user stats
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
    userStats: userManager.getUserStats(userId)
  });
};

exports.cleanupSessionImages = async (req, res) => {
  try {
    const { sessionId } = req.body;
    const userId = req.user.id;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID required' });
    }
    
    if (!sessionStore.validateUserSession(userId, sessionId)) {
      return res.status(403).json({ error: 'Access denied: Cannot cleanup another user\'s session' });
    }
    
    const result = await pdfService.cleanupSessionImages(sessionId, userId);
    
    res.json({ 
      success: true, 
      message: 'Session images cleaned up successfully',
      sessionId,
      deletedCount: result?.deleted || 0,
      totalCount: result?.total || 0,
      userStats: userManager.getUserStats(userId)
    });
    
  } catch (error) {
    console.error('Cleanup endpoint error:', error);
    res.status(500).json({ 
      error: 'Failed to cleanup session images',
      message: error.message 
    });
  }
};

exports.getActiveSessions = (req, res) => {
  const userId = req.user.id;
  const userSessions = sessionStore.getUserSessions(userId);
  
  res.json({ 
    activeSessions: userSessions,
    count: userSessions.length,
    userStats: userManager.getUserStats(userId)
  });
};

// Get system stats for monitoring
exports.getSystemStats = (req, res) => {
  const userId = req.user.id;
  
  res.json({
    userStats: userManager.getUserStats(userId),
    globalStats: {
      activeUsers: userProcessingQueues.size,
      totalActiveSessions: userManager.globalActiveCount,
      maxGlobalSessions: userManager.maxGlobalConcurrent,
      systemLoad: Math.round((userManager.globalActiveCount / userManager.maxGlobalConcurrent) * 100)
    },
    timestamp: new Date().toISOString()
  });
};

// Cleanup intervals with error handling
setInterval(async () => {
  try {
    const expiredSessions = sessionStore.cleanupOldSessions();
    for (const { sessionId, userId } of expiredSessions) {
      try {
        await pdfService.cleanupSessionImages(sessionId, userId);
        userManager.endUserProcessing(userId, sessionId);
      } catch (error) {
        console.error(`Failed to cleanup expired session ${sessionId}:`, error.message);
      }
    }
  } catch (error) {
    console.error('Periodic cleanup error:', error);
  }
}, 5 * 60 * 1000);

process.on('SIGTERM', async () => {
  console.log('Cleaning up all sessions on process exit...');
  for (const [sessionId, session] of activeProcessingSessions.entries()) {
    cleanupSession(sessionId, session.pdfPath, session.userId, false);
  }
});

process.on('SIGINT', async () => {
  console.log('Cleaning up all sessions on process interrupt...');
  for (const [sessionId, session] of activeProcessingSessions.entries()) {
    cleanupSession(sessionId, session.pdfPath, session.userId, false);
  }
  process.exit(0);
});
const fs = require('fs');
const path = require('path');
const pdfService = require('../services/pdfService');
const geminiService = require('../services/geminiService');
const calculationService = require('../services/calculationService');

// Store for tracking active processing sessions with user isolation
const activeProcessingSessions = new Map();

// Get base URL from environment
const getBaseURL = () => {
  return process.env.BACKEND_URL || 'http://localhost:5000';
};

// Generate unique session ID for each user's processing request
const generateSessionId = (userId) => {
  return `session_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

// Cleanup function for a session
const cleanupSession = (sessionId, pdfPath, userId) => {
  console.log(`🧹 Cleaning up session: ${sessionId} for user: ${userId}`);
  
  // Remove from active sessions
  activeProcessingSessions.delete(sessionId);
  
  // Delete PDF file if it exists
  if (pdfPath && fs.existsSync(pdfPath)) {
    try {
      fs.unlinkSync(pdfPath);
      console.log(`✅ Deleted PDF file: ${pdfPath}`);
    } catch (error) {
      console.error(`❌ Error deleting PDF file:`, error.message);
    }
  }

  // Clean up any temporary images for this session
  try {
    const tempImagesDir = path.join(__dirname, '..', 'temp_images');
    const sessionImages = fs.readdirSync(tempImagesDir)
      .filter(file => file.includes(sessionId.split('_')[2])); // Use timestamp part
    
    sessionImages.forEach(image => {
      const imagePath = path.join(tempImagesDir, image);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
        console.log(`🗑️ Deleted session image: ${image}`);
      }
    });
  } catch (error) {
    console.log(`Warning: Could not clean session images: ${error.message}`);
  }
};

exports.processPDF = async (req, res) => {
  let pdfPath = null;
  const baseURL = getBaseURL();
  const userId = req.user.id; // Get user ID from authenticated request
  const userEmail = req.user.email;
  const sessionId = generateSessionId(userId);
  
  // Track if processing should be cancelled
  let shouldCancel = false;
  let isCleanedUp = false;
  
  // Cleanup wrapper to prevent double cleanup
  const safeCleanup = (reason) => {
    if (!isCleanedUp) {
      console.log(`🧹 Cleanup triggered: ${reason}`);
      isCleanedUp = true;
      cleanupSession(sessionId, pdfPath, userId);
    }
  };
  
  try {
    pdfPath = req.file.path;
    
    // Register this session with user isolation
    activeProcessingSessions.set(sessionId, {
      userId: userId,
      userEmail: userEmail,
      pdfPath,
      startTime: Date.now(),
      cancel: () => {
        shouldCancel = true;
        console.log(`🛑 Cancellation requested for session: ${sessionId} (User: ${userEmail})`);
      }
    });
    
    console.log('\n' + '='.repeat(70));
    console.log('NEW PDF PROCESSING REQUEST');
    console.log('='.repeat(70));
    console.log(`Session ID: ${sessionId}`);
    console.log(`User ID: ${userId}`);
    console.log(`User Email: ${userEmail}`);
    console.log(`PDF: ${pdfPath}`);
    console.log(`Base URL: ${baseURL}`);
    
    // Monitor request for early disconnection
    req.on('close', () => {
      console.log(`🔌 Client disconnected for session: ${sessionId} (User: ${userEmail})`);
      shouldCancel = true;
      safeCleanup('Client disconnect');
    });
    
    // Monitor response for early disconnection
    res.on('close', () => {
      console.log(`🔌 Response closed for session: ${sessionId} (User: ${userEmail})`);
      shouldCancel = true;
      safeCleanup('Response close');
    });
    
    // Check if client already disconnected before we start
    if (req.aborted || res.destroyed) {
      console.log(`❌ Request already aborted for session: ${sessionId}`);
      safeCleanup('Request aborted before start');
      return;
    }
    
    const pageCount = await pdfService.getPDFPageCount(pdfPath);
    console.log(`Total pages: ${pageCount}`);
    
    // Check cancellation after getting page count
    if (shouldCancel) {
      console.log(`🛑 Cancelled after getting page count`);
      safeCleanup('Cancelled after page count');
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
      message: `Found ${pageCount} pages. Converting all pages to images...` 
    })}\n\n`);

    // PHASE 1: Convert all pages to images in parallel (fast operation)
    console.log('\nPHASE 1: Converting all pages to images in parallel...');
    
    res.write(`data: ${JSON.stringify({ 
      type: 'progress', 
      totalPages: pageCount, 
      currentPage: 0,
      phase: 'conversion',
      sessionId: sessionId,
      message: `Converting ${pageCount} pages to images in parallel...` 
    })}\n\n`);

    // Convert all pages in parallel for maximum speed
    const imageConversionPromises = [];
    for (let i = 1; i <= pageCount; i++) {
      imageConversionPromises.push(
        (async (pageNumber) => {
          try {
            const imageData = await pdfService.convertPDFPageToImage(pdfPath, pageNumber, sessionId);
            const imageUrl = `${baseURL}${imageData.url}`;
            
            return {
              pageNumber: pageNumber,
              base64: imageData.base64,
              imageUrl: imageUrl
            };
          } catch (error) {
            console.error(`Error converting page ${pageNumber} for user ${userEmail}:`, error.message);
            return {
              pageNumber: pageNumber,
              base64: null,
              imageUrl: null,
              conversionError: error.message
            };
          }
        })(i)
      );
    }

    // Wait for all image conversions to complete
    const allImages = await Promise.all(imageConversionPromises);
    
    // Sort by page number to ensure correct order
    allImages.sort((a, b) => a.pageNumber - b.pageNumber);

    console.log(`\nAll ${pageCount} pages converted to images for user ${userEmail}`);
    
    // Check cancellation before analysis
    if (shouldCancel || req.aborted || res.destroyed) {
      console.log(`🛑 Cancelled before analysis phase`);
      safeCleanup('Cancelled before analysis');
      return res.end();
    }

    // PHASE 2: Analyze all images in parallel using multiple API keys (MAXIMUM SPEED)
    console.log(`\nPHASE 2: Analyzing all pages in PARALLEL for user ${userEmail}...`);
    
    res.write(`data: ${JSON.stringify({ 
      type: 'status',
      totalPages: pageCount,
      currentPage: 0,
      phase: 'analysis',
      sessionId: sessionId,
      message: `Analyzing all ${pageCount} pages in parallel with ${process.env.GEMINI_API_KEY_1 ? 'multiple' : 'single'} API keys...` 
    })}\n\n`);

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

    // Filter out images with conversion errors
    const validImages = allImages.filter(img => img.base64 !== null);
    
    if (validImages.length === 0) {
      throw new Error('All pages failed to convert to images');
    }

    // Analyze all images in parallel for maximum speed
    const analysisResults = await geminiService.analyzeImagesParallel(
      validImages,
      (completed, total, pageNumber) => {
        // Check cancellation during analysis
        if (shouldCancel || req.aborted || res.destroyed) {
          return;
        }

        // Send progress update (non-blocking)
        try {
          res.write(`data: ${JSON.stringify({ 
            type: 'progress',
            totalPages: total,
            currentPage: completed,
            phase: 'analysis',
            sessionId: sessionId,
            message: `Analyzed ${completed}/${total} pages...`,
            pageNumber: pageNumber
          })}\n\n`);
        } catch (writeError) {
          // If write fails, client likely disconnected
          shouldCancel = true;
        }
      }
    );

    // Check cancellation after analysis
    if (shouldCancel || req.aborted || res.destroyed) {
      console.log(`🛑 Cancelled after analysis phase`);
      safeCleanup('Cancelled after analysis');
      return res.end();
    }

    // PHASE 3: Process all results in parallel (MAXIMUM SPEED)
    console.log(`\nPHASE 3: Processing all results in PARALLEL for user ${userEmail}...`);
    
    // Process all pages in parallel instead of sequentially
    const pageProcessingPromises = allImages.map(async (imageInfo, index) => {
      const pageNumber = imageInfo.pageNumber;

      if (imageInfo.conversionError) {
        // Page had conversion error
        const errorPageData = {
          pageNumber: pageNumber,
          data: { 
            labour: [], 
            material: [], 
            equipment: [], 
            consumables: [], 
            subtrade: [],
            labourTimesheet: [],
            equipmentLog: []
          },
          rawOutput: `Conversion Error: ${imageInfo.conversionError}`,
          imageUrl: null,
          error: `Failed to convert page: ${imageInfo.conversionError}`
        };

        // Send immediate update for error page
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
              message: `Page ${pageNumber} failed (conversion error)` 
            })}\n\n`);
          } catch (writeError) {
            shouldCancel = true;
          }
        }
        
        return errorPageData;
      }

      // Find analysis result for this page
      const resultIndex = validImages.findIndex(img => img.pageNumber === pageNumber);
      const analysisResult = analysisResults[resultIndex];

      const pageResult = calculationService.processPageData(analysisResult.parsed);
      
      const pageResultWithPageNumber = {
        labour: pageResult.labour.map(item => ({ ...item, pageNumber })),
        material: pageResult.material.map(item => ({ ...item, pageNumber })),
        equipment: pageResult.equipment.map(item => ({ ...item, pageNumber })),
        consumables: pageResult.consumables.map(item => ({ ...item, pageNumber })),
        subtrade: pageResult.subtrade.map(item => ({ ...item, pageNumber })),
        labourTimesheet: pageResult.labourTimesheet.map(item => ({ ...item, pageNumber })),
        equipmentLog: pageResult.equipmentLog.map(item => ({ ...item, pageNumber }))
      };

      const processedPageData = {
        pageNumber: pageNumber,
        data: pageResultWithPageNumber,
        rawOutput: analysisResult.raw,
        imageUrl: imageInfo.imageUrl,
        error: analysisResult.error
      };

      // Send immediate update for successful page
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

      return processedPageData;
    });

    // Wait for all page processing to complete
    const processedPages = await Promise.all(pageProcessingPromises);
    
    // Sort by page number and compile results
    processedPages.sort((a, b) => a.pageNumber - b.pageNumber);
    allPagesData.push(...processedPages);

    // Compile collected results
    processedPages.forEach(pageData => {
      if (pageData.data) {
        collectedResult.labour.push(...pageData.data.labour);
        collectedResult.material.push(...pageData.data.material);
        collectedResult.equipment.push(...pageData.data.equipment);
        collectedResult.consumables.push(...pageData.data.consumables);
        collectedResult.subtrade.push(...pageData.data.subtrade);
        collectedResult.labourTimesheet.push(...pageData.data.labourTimesheet);
        collectedResult.equipmentLog.push(...pageData.data.equipmentLog);
      }
    });
    
    // Final check for cancellation
    if (shouldCancel || req.aborted || res.destroyed) {
      console.log(`🛑 Processing cancelled before completion`);
      safeCleanup('Cancelled before completion');
      return res.end();
    }
    
    safeCleanup('Processing completed successfully');
    
    console.log(`\nPROCESSING COMPLETE for user ${userEmail}`);
    console.log(`Labour items: ${collectedResult.labour.length}`);
    console.log(`Labour Timesheet items: ${collectedResult.labourTimesheet.length}`);
    console.log(`Material items: ${collectedResult.material.length}`);
    console.log(`Equipment items: ${collectedResult.equipment.length}`);
    console.log(`Equipment Log items: ${collectedResult.equipmentLog.length}`);
    console.log(`Consumables items: ${collectedResult.consumables.length}`);
    console.log(`Subtrade items: ${collectedResult.subtrade.length}`);
    
    res.write(`data: ${JSON.stringify({ 
      type: 'complete',
      sessionId: sessionId,
      allPagesData: allPagesData,
      collectedResult: collectedResult,
      totalPages: pageCount,
      processedBy: userEmail,
      processedAt: new Date().toISOString(),
      message: 'All pages processed successfully!' 
    })}\n\n`);

    res.end();
    
  } catch (error) {
    console.error(`\nPROCESSING ERROR for user ${userEmail}:`, error);
    
    safeCleanup('Error occurred');
    
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
  }
};

// Cancel processing endpoint with user validation
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
  
  // Ensure user can only cancel their own sessions
  if (session.userId !== userId) {
    return res.status(403).json({ error: 'Access denied: Cannot cancel another user\'s session' });
  }
  
  session.cancel();
  
  res.json({ 
    success: true, 
    message: 'Processing cancellation requested',
    sessionId,
    userId 
  });
};

// Get active sessions for current user
exports.getActiveSessions = (req, res) => {
  const userId = req.user.id;
  const userSessions = [];
  
  for (const [sessionId, session] of activeProcessingSessions.entries()) {
    if (session.userId === userId) {
      userSessions.push({
        sessionId,
        startTime: session.startTime,
        duration: Date.now() - session.startTime
      });
    }
  }
  
  res.json({ 
    activeSessions: userSessions,
    count: userSessions.length 
  });
};

// Cleanup old sessions periodically with user isolation
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes
  
  for (const [sessionId, session] of activeProcessingSessions.entries()) {
    if (now - session.startTime > maxAge) {
      console.log(`⏰ Cleaning up stale session: ${sessionId} for user: ${session.userEmail}`);
      cleanupSession(sessionId, session.pdfPath, session.userId);
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// Cleanup on process exit
process.on('SIGTERM', () => {
  console.log('🧹 Cleaning up all sessions on process exit...');
  for (const [sessionId, session] of activeProcessingSessions.entries()) {
    cleanupSession(sessionId, session.pdfPath, session.userId);
  }
});

process.on('SIGINT', () => {
  console.log('🧹 Cleaning up all sessions on process interrupt...');
  for (const [sessionId, session] of activeProcessingSessions.entries()) {
    cleanupSession(sessionId, session.pdfPath, session.userId);
  }
  process.exit(0);
});
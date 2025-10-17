const fs = require('fs');
const path = require('path');
const pdfService = require('../services/pdfService');
const geminiService = require('../services/geminiService');
const calculationService = require('../services/calculationService');
const sessionStore = require('../services/sessionStore');

const activeProcessingSessions = new Map();

const getBaseURL = () => {
  return process.env.BACKEND_URL || 'http://localhost:5000';
};

const generateSessionId = (userId) => {
  return `session_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

const cleanupSession = (sessionId, pdfPath, userId, keepImages = false) => {
  console.log(`🧹 Cleaning up session: ${sessionId} for user: ${userId} (keepImages: ${keepImages})`);
  
  activeProcessingSessions.delete(sessionId);
  
  if (pdfPath && fs.existsSync(pdfPath)) {
    try {
      fs.unlinkSync(pdfPath);
      console.log(`✅ Deleted PDF file: ${pdfPath}`);
    } catch (error) {
      console.error(`❌ Error deleting PDF file:`, error.message);
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

exports.processPDF = async (req, res) => {
  let pdfPath = null;
  const baseURL = getBaseURL();
  const userId = req.user.id;
  const userEmail = req.user.email;
  const sessionId = generateSessionId(userId);
  
  let shouldCancel = false;
  let isCleanedUp = false;
  
  const safeCleanup = (reason, keepImages = true) => {
    if (!isCleanedUp) {
      console.log(`🧹 Cleanup triggered: ${reason} (keepImages: ${keepImages})`);
      isCleanedUp = true;
      cleanupSession(sessionId, pdfPath, userId, keepImages);
    }
  };
  
  try {
    pdfPath = req.file.path;
    
    // Register session with enhanced security
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
      message: `Found ${pageCount} pages. Converting all pages to images...` 
    })}\n\n`);

    console.log('\nPHASE 1: Converting all pages to images in parallel...');
    
    res.write(`data: ${JSON.stringify({ 
      type: 'progress', 
      totalPages: pageCount, 
      currentPage: 0,
      phase: 'conversion',
      sessionId: sessionId,
      message: `Converting ${pageCount} pages to images in parallel...` 
    })}\n\n`);

    const imageConversionPromises = [];
    for (let i = 1; i <= pageCount; i++) {
      imageConversionPromises.push(
        (async (pageNumber) => {
          try {
            const imageData = await pdfService.convertPDFPageToImage(pdfPath, pageNumber, sessionId, userId);
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

    const allImages = await Promise.all(imageConversionPromises);
    allImages.sort((a, b) => a.pageNumber - b.pageNumber);

    console.log(`\nAll ${pageCount} pages converted to images for user ${userEmail}`);
    
    if (shouldCancel || req.aborted || res.destroyed) {
      safeCleanup('Cancelled before analysis', true);
      return res.end();
    }

    console.log(`\nPHASE 2: Analyzing all pages in PARALLEL for user ${userEmail}...`);
    
    res.write(`data: ${JSON.stringify({ 
      type: 'status',
      totalPages: pageCount,
      currentPage: 0,
      phase: 'analysis',
      sessionId: sessionId,
      message: `Analyzing all ${pageCount} pages in parallel...` 
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

    const validImages = allImages.filter(img => img.base64 !== null);
    
    if (validImages.length === 0) {
      throw new Error('All pages failed to convert to images');
    }

    const analysisResults = await geminiService.analyzeImagesParallel(
      validImages,
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
            message: `Analyzed ${completed}/${total} pages...`,
            pageNumber: pageNumber
          })}\n\n`);
        } catch (writeError) {
          shouldCancel = true;
        }
      }
    );

    if (shouldCancel || req.aborted || res.destroyed) {
      safeCleanup('Cancelled after analysis', true);
      return res.end();
    }

    console.log(`\nPHASE 3: Processing all results in PARALLEL for user ${userEmail}...`);
    
    const pageProcessingPromises = allImages.map(async (imageInfo, index) => {
      const pageNumber = imageInfo.pageNumber;

      if (imageInfo.conversionError) {
        const errorPageData = {
          pageNumber: pageNumber,
          data: { 
            labour: [], material: [], equipment: [], consumables: [], 
            subtrade: [], labourTimesheet: [], equipmentLog: []
          },
          rawOutput: `Conversion Error: ${imageInfo.conversionError}`,
          imageUrl: null,
          error: `Failed to convert page: ${imageInfo.conversionError}`
        };

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

    const processedPages = await Promise.all(pageProcessingPromises);
    processedPages.sort((a, b) => a.pageNumber - b.pageNumber);
    allPagesData.push(...processedPages);

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
    
    if (shouldCancel || req.aborted || res.destroyed) {
      safeCleanup('Cancelled before completion', true);
      return res.end();
    }
    
    safeCleanup('Processing completed successfully', true);
    
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
    
    safeCleanup('Error occurred', true);
    
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
    userId 
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
      totalCount: result?.total || 0
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
    count: userSessions.length
  });
};

setInterval(async () => {
  try {
    const expiredSessions = sessionStore.cleanupOldSessions();
    for (const { sessionId, userId } of expiredSessions) {
      try {
        await pdfService.cleanupSessionImages(sessionId, userId);
      } catch (error) {
        console.error(`Failed to cleanup expired session ${sessionId}:`, error.message);
      }
    }
  } catch (error) {
    console.error('Periodic cleanup error:', error);
  }
}, 5 * 60 * 1000);

process.on('SIGTERM', async () => {
  console.log('🧹 Cleaning up all sessions on process exit...');
  for (const [sessionId, session] of activeProcessingSessions.entries()) {
    cleanupSession(sessionId, session.pdfPath, session.userId, false);
  }
});

process.on('SIGINT', async () => {
  console.log('🧹 Cleaning up all sessions on process interrupt...');
  for (const [sessionId, session] of activeProcessingSessions.entries()) {
    cleanupSession(sessionId, session.pdfPath, session.userId, false);
  }
  process.exit(0);
});
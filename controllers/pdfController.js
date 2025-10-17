const fs = require('fs');
const pdfService = require('../services/pdfService');
const geminiService = require('../services/geminiService');
const calculationService = require('../services/calculationService');

// Store for tracking active processing sessions
const activeProcessingSessions = new Map();

// Get base URL from environment
const getBaseURL = () => {
  return process.env.BACKEND_URL || 'http://localhost:5000';
};

// Cleanup function for a session
const cleanupSession = (sessionId, pdfPath) => {
  console.log(`🧹 Cleaning up session: ${sessionId}`);
  
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
};

exports.processPDF = async (req, res) => {
  let pdfPath = null;
  const baseURL = getBaseURL();
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Track if processing should be cancelled
  let shouldCancel = false;
  let isCleanedUp = false;
  
  // Cleanup wrapper to prevent double cleanup
  const safeCleanup = (reason) => {
    if (!isCleanedUp) {
      console.log(`🧹 Cleanup triggered: ${reason}`);
      isCleanedUp = true;
      cleanupSession(sessionId, pdfPath);
    }
  };
  
  try {
    pdfPath = req.file.path;
    
    // Register this session
    activeProcessingSessions.set(sessionId, {
      pdfPath,
      startTime: Date.now(),
      cancel: () => {
        shouldCancel = true;
        console.log(`🛑 Cancellation requested for session: ${sessionId}`);
      }
    });
    
    console.log('\n' + '='.repeat(70));
    console.log('NEW PDF PROCESSING REQUEST');
    console.log('='.repeat(70));
    console.log(`Session ID: ${sessionId}`);
    console.log(`PDF: ${pdfPath}`);
    console.log(`Base URL: ${baseURL}`);
    
    // Monitor request for early disconnection
    req.on('close', () => {
      console.log(`🔌 Client disconnected for session: ${sessionId}`);
      shouldCancel = true;
      safeCleanup('Client disconnect');
    });
    
    // Monitor response for early disconnection
    res.on('close', () => {
      console.log(`🔌 Response closed for session: ${sessionId}`);
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

    res.write(`data: ${JSON.stringify({ 
      type: 'status', 
      totalPages: pageCount, 
      currentPage: 0,
      sessionId: sessionId,
      message: `Found ${pageCount} pages. Converting all pages to images...` 
    })}\n\n`);

    // PHASE 1: Convert all pages to images first (fast operation)
    console.log('\nPHASE 1: Converting all pages to images...');
    const allImages = [];
    
    for (let i = 1; i <= pageCount; i++) {
      if (shouldCancel || req.aborted || res.destroyed) {
        console.log(`🛑 Cancelled during image conversion`);
        safeCleanup('Cancelled during image conversion');
        return res.end();
      }

      try {
        res.write(`data: ${JSON.stringify({ 
          type: 'progress', 
          totalPages: pageCount, 
          currentPage: i,
          phase: 'conversion',
          message: `Converting page ${i}/${pageCount} to image...` 
        })}\n\n`);

        const imageData = await pdfService.convertPDFPageToImage(pdfPath, i);
        const imageUrl = `${baseURL}${imageData.url}`;
        
        allImages.push({
          pageNumber: i,
          base64: imageData.base64,
          imageUrl: imageUrl
        });

        console.log(`Converted page ${i}/${pageCount}`);
      } catch (error) {
        console.error(`Error converting page ${i}:`, error.message);
        allImages.push({
          pageNumber: i,
          base64: null,
          imageUrl: null,
          conversionError: error.message
        });
      }
    }

    console.log(`\nAll ${pageCount} pages converted to images`);
    
    // Check cancellation before analysis
    if (shouldCancel || req.aborted || res.destroyed) {
      console.log(`🛑 Cancelled before analysis phase`);
      safeCleanup('Cancelled before analysis');
      return res.end();
    }

    // PHASE 2: Analyze all images in parallel using multiple API keys
    console.log('\nPHASE 2: Analyzing all pages in parallel with multiple API keys...');
    
    res.write(`data: ${JSON.stringify({ 
      type: 'status',
      totalPages: pageCount,
      currentPage: 0,
      phase: 'analysis',
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

    // Filter out images with conversion errors
    const validImages = allImages.filter(img => img.base64 !== null);
    
    if (validImages.length === 0) {
      throw new Error('All pages failed to convert to images');
    }

    // Analyze all images in parallel
    const analysisResults = await geminiService.analyzeImagesParallel(
      validImages,
      (completed, total, pageNumber) => {
        // Check cancellation during analysis
        if (shouldCancel || req.aborted || res.destroyed) {
          return;
        }

        // Send progress update
        res.write(`data: ${JSON.stringify({ 
          type: 'progress',
          totalPages: total,
          currentPage: completed,
          phase: 'analysis',
          message: `Analyzed ${completed}/${total} pages...`,
          pageNumber: pageNumber
        })}\n\n`);
      }
    );

    // Check cancellation after analysis
    if (shouldCancel || req.aborted || res.destroyed) {
      console.log(`🛑 Cancelled after analysis phase`);
      safeCleanup('Cancelled after analysis');
      return res.end();
    }

    // PHASE 3: Process all results
    console.log('\nPHASE 3: Processing all results...');
    
    for (let i = 0; i < allImages.length; i++) {
      const imageInfo = allImages[i];
      const pageNumber = imageInfo.pageNumber;

      if (imageInfo.conversionError) {
        // Page had conversion error
        allPagesData.push({
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
        });

        res.write(`data: ${JSON.stringify({ 
          type: 'page_complete', 
          pageNumber: pageNumber,
          pageData: { 
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
          error: `Failed to convert page: ${imageInfo.conversionError}`,
          message: `Page ${pageNumber} failed (conversion error)` 
        })}\n\n`);
        
        continue;
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

      allPagesData.push({
        pageNumber: pageNumber,
        data: pageResultWithPageNumber,
        rawOutput: analysisResult.raw,
        imageUrl: imageInfo.imageUrl,
        error: analysisResult.error
      });

      collectedResult.labour.push(...pageResultWithPageNumber.labour);
      collectedResult.material.push(...pageResultWithPageNumber.material);
      collectedResult.equipment.push(...pageResultWithPageNumber.equipment);
      collectedResult.consumables.push(...pageResultWithPageNumber.consumables);
      collectedResult.subtrade.push(...pageResultWithPageNumber.subtrade);
      collectedResult.labourTimesheet.push(...pageResultWithPageNumber.labourTimesheet);
      collectedResult.equipmentLog.push(...pageResultWithPageNumber.equipmentLog);

      res.write(`data: ${JSON.stringify({ 
        type: 'page_complete', 
        pageNumber: pageNumber,
        pageData: pageResultWithPageNumber,
        rawOutput: analysisResult.raw,
        imageUrl: imageInfo.imageUrl,
        error: analysisResult.error,
        message: analysisResult.error ? `Page ${pageNumber} completed with warnings` : `Page ${pageNumber} complete` 
      })}\n\n`);
    }
    
    // Final check for cancellation
    if (shouldCancel || req.aborted || res.destroyed) {
      console.log(`🛑 Processing cancelled before completion`);
      safeCleanup('Cancelled before completion');
      return res.end();
    }
    
    safeCleanup('Processing completed successfully');
    
    console.log('\nPROCESSING COMPLETE');
    console.log(`Labour items: ${collectedResult.labour.length}`);
    console.log(`Labour Timesheet items: ${collectedResult.labourTimesheet.length}`);
    console.log(`Material items: ${collectedResult.material.length}`);
    console.log(`Equipment items: ${collectedResult.equipment.length}`);
    console.log(`Equipment Log items: ${collectedResult.equipmentLog.length}`);
    console.log(`Consumables items: ${collectedResult.consumables.length}`);
    console.log(`Subtrade items: ${collectedResult.subtrade.length}`);
    
    res.write(`data: ${JSON.stringify({ 
      type: 'complete',
      allPagesData: allPagesData,
      collectedResult: collectedResult,
      totalPages: pageCount,
      message: 'All pages processed successfully!' 
    })}\n\n`);

    res.end();
    
  } catch (error) {
    console.error('\nPROCESSING ERROR:', error);
    
    safeCleanup('Error occurred');
    
    if (!res.headersSent) {
      res.write(`data: ${JSON.stringify({ 
        type: 'error',
        error: error.message 
      })}\n\n`);
    }
    
    if (!res.destroyed) {
      res.end();
    }
  }
};

// Optional: Endpoint to manually cancel a session (not required with current implementation)
exports.cancelProcessing = (req, res) => {
  const { sessionId } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }
  
  const session = activeProcessingSessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found or already completed' });
  }
  
  session.cancel();
  
  res.json({ 
    success: true, 
    message: 'Processing cancellation requested',
    sessionId 
  });
};

// Cleanup old sessions periodically (optional but recommended)
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes
  
  for (const [sessionId, session] of activeProcessingSessions.entries()) {
    if (now - session.startTime > maxAge) {
      console.log(`⏰ Cleaning up stale session: ${sessionId}`);
      cleanupSession(sessionId, session.pdfPath);
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes
const fs = require('fs');
const pdfService = require('../services/pdfService');
const geminiService = require('../services/geminiService');
const calculationService = require('../services/calculationService');

exports.processPDF = async (req, res) => {
  let pdfPath = null;
  
  try {
    pdfPath = req.file.path;
    
    console.log('\n' + '='.repeat(70));
    console.log('NEW PDF PROCESSING REQUEST');
    console.log('='.repeat(70));
    console.log(`PDF: ${pdfPath}`);
    
    const pageCount = await pdfService.getPDFPageCount(pdfPath);
    console.log(`Total pages: ${pageCount}`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.write(`data: ${JSON.stringify({ 
      type: 'status', 
      totalPages: pageCount, 
      currentPage: 0,
      message: `Found ${pageCount} pages. Starting conversion...` 
    })}\n\n`);

    const allPagesData = [];
    const collectedResult = {
      labour: [],
      material: [],
      equipment: [],
      consumables: [],
      subtrade: []
    };

    for (let i = 1; i <= pageCount; i++) {
      try {
        console.log(`\nPROCESSING PAGE ${i}/${pageCount}`);
        
        res.write(`data: ${JSON.stringify({ 
          type: 'progress', 
          totalPages: pageCount, 
          currentPage: i,
          message: `Converting page ${i} to high-quality image...` 
        })}\n\n`);

        const imageData = await pdfService.convertPDFPageToImage(pdfPath, i);
        
        res.write(`data: ${JSON.stringify({ 
          type: 'image_ready', 
          pageNumber: i,
          imageUrl: `http://localhost:5000${imageData.url}`,
          message: `Image ready for page ${i}` 
        })}\n\n`);

        res.write(`data: ${JSON.stringify({ 
          type: 'progress', 
          totalPages: pageCount, 
          currentPage: i,
          imageUrl: `http://localhost:5000${imageData.url}`,
          message: `Extracting data from page ${i}...` 
        })}\n\n`);

        const { parsed: extractedData, raw: rawOutput, error: parseError } = await geminiService.analyzeImage(imageData.base64, i);
        
        const pageResult = calculationService.processPageData(extractedData);
        
        const pageResultWithPageNumber = {
          labour: pageResult.labour.map(item => ({ ...item, pageNumber: i })),
          material: pageResult.material.map(item => ({ ...item, pageNumber: i })),
          equipment: pageResult.equipment.map(item => ({ ...item, pageNumber: i })),
          consumables: pageResult.consumables.map(item => ({ ...item, pageNumber: i })),
          subtrade: pageResult.subtrade.map(item => ({ ...item, pageNumber: i }))
        };

        allPagesData.push({
          pageNumber: i,
          data: pageResultWithPageNumber,
          rawOutput: rawOutput,
          imageUrl: `http://localhost:5000${imageData.url}`,
          error: parseError
        });

        collectedResult.labour.push(...pageResultWithPageNumber.labour);
        collectedResult.material.push(...pageResultWithPageNumber.material);
        collectedResult.equipment.push(...pageResultWithPageNumber.equipment);
        collectedResult.consumables.push(...pageResultWithPageNumber.consumables);
        collectedResult.subtrade.push(...pageResultWithPageNumber.subtrade);

        res.write(`data: ${JSON.stringify({ 
          type: 'page_complete', 
          pageNumber: i,
          pageData: pageResultWithPageNumber,
          rawOutput: rawOutput,
          imageUrl: `http://localhost:5000${imageData.url}`,
          error: parseError,
          message: parseError ? `Page ${i} completed with warnings` : `Page ${i} complete` 
        })}\n\n`);

        if (parseError) {
          console.log(`Page ${i} had parsing errors but data was preserved`);
        } else {
          console.log(`Page ${i}/${pageCount} completed successfully`);
        }
        
      } catch (pageError) {
        console.error(`Error on page ${i}:`, pageError.message);
        
        res.write(`data: ${JSON.stringify({ 
          type: 'page_complete', 
          pageNumber: i,
          pageData: { labour: [], material: [], equipment: [], consumables: [], subtrade: [] },
          rawOutput: `Error: ${pageError.message}`,
          imageUrl: null,
          error: `Error processing page: ${pageError.message}`,
          message: `Page ${i} failed but continuing...` 
        })}\n\n`);
        
        allPagesData.push({
          pageNumber: i,
          data: { labour: [], material: [], equipment: [], consumables: [], subtrade: [] },
          rawOutput: `Error: ${pageError.message}`,
          imageUrl: null,
          error: `Error processing page: ${pageError.message}`
        });
      }
      
      if (i < pageCount) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    if (pdfPath && fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
      console.log(`\nCleaned up temporary PDF file`);
    }
    
    console.log('\nPROCESSING COMPLETE');
    console.log(`Labour items: ${collectedResult.labour.length}`);
    console.log(`Material items: ${collectedResult.material.length}`);
    console.log(`Equipment items: ${collectedResult.equipment.length}`);
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
    
    if (pdfPath && fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }
    
    res.write(`data: ${JSON.stringify({ 
      type: 'error',
      error: error.message 
    })}\n\n`);
    res.end();
  }
};
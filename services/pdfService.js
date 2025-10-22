const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sessionStore = require('./sessionStore');

const execPromise = util.promisify(exec);

// Robust PDF page converter with automatic retry and error handling
exports.convertPDFPageToImage = async (pdfPath, pageNumber, sessionId = null, userId = null, retryCount = 0) => {
  const maxRetries = 2; // Try 2 more times if initial conversion fails
  
  try {
    const tempImagesDir = path.join(__dirname, '..', 'temp_images');
    
    if (!fs.existsSync(tempImagesDir)) {
      fs.mkdirSync(tempImagesDir, { recursive: true });
    }
    
    // Validate PDF file exists and is readable
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`PDF file not found: ${pdfPath}`);
    }
    
    const pdfStats = fs.statSync(pdfPath);
    if (pdfStats.size === 0) {
      throw new Error(`PDF file is empty: ${pdfPath}`);
    }
    
    const timestamp = sessionId ? sessionId.split('_')[2] : Date.now();
    const userHash = userId ? crypto.createHash('sha256').update(userId).digest('hex').substring(0, 8) : 'unknown';
    const randomComponent = crypto.randomBytes(8).toString('hex');
    
    const outputPrefix = path.join(tempImagesDir, `page_${pageNumber}_${userHash}_${timestamp}_${randomComponent}`);
    const finalImagePath = `${outputPrefix}.png`;
    
    // Enhanced command with better error handling and timeout
    const command = `pdftocairo -png -f ${pageNumber} -l ${pageNumber} -r 200 -singlefile "${pdfPath}" "${outputPrefix}"`;
    
    console.log(`   Converting page ${pageNumber} (attempt ${retryCount + 1}/${maxRetries + 1})...`);
    
    const { stdout, stderr } = await execPromise(command, {
      timeout: 45000, // Increased timeout to 45 seconds
      maxBuffer: 20 * 1024 * 1024, // Increased buffer to 20MB
      env: { ...process.env, LANG: 'C' } // Ensure consistent locale
    });
    
    // Check for warnings but don't fail on them
    if (stderr && !stderr.includes('Syntax Warning') && !stderr.includes('Invalid ToUnicode')) {
      console.log(`   Warning for page ${pageNumber}: ${stderr.substring(0, 100)}...`);
    }
    
    // Verify the image was created successfully
    if (!fs.existsSync(finalImagePath)) {
      throw new Error(`Image file not created for page ${pageNumber}. Command output: ${stdout || 'No output'}`);
    }
    
    const stats = fs.statSync(finalImagePath);
    if (stats.size === 0) {
      // Delete empty file and throw error
      fs.unlinkSync(finalImagePath);
      throw new Error(`Generated image is empty for page ${pageNumber}`);
    }
    
    console.log(`   ✓ Page ${pageNumber} converted successfully: ${(stats.size / 1024).toFixed(1)}KB`);
    
    const imageBuffer = fs.readFileSync(finalImagePath);
    const base64 = imageBuffer.toString('base64');
    
    const imageFileName = `page_${pageNumber}_${userHash}_${timestamp}_${randomComponent}.png`;
    
    // Register image with session store
    if (sessionId && userId) {
      sessionStore.registerImage(sessionId, imageFileName, userId);
    }
    
    return {
      base64: `data:image/png;base64,${base64}`,
      url: `/images/${imageFileName}`,
      size: stats.size,
      path: finalImagePath,
      fileName: imageFileName,
      success: true
    };
    
  } catch (error) {
    console.error(`   ❌ Error converting page ${pageNumber} (attempt ${retryCount + 1}):`, error.message);
    
    // Automatic retry logic - only retry 2 more times as requested
    if (retryCount < maxRetries) {
      console.log(`   🔄 Retrying page ${pageNumber} conversion (${retryCount + 1}/${maxRetries})...`);
      
      // Wait before retry with exponential backoff
      const waitTime = Math.min(1000 * Math.pow(2, retryCount), 5000);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      
      // Recursive retry
      return await exports.convertPDFPageToImage(pdfPath, pageNumber, sessionId, userId, retryCount + 1);
    }
    
    // After all retries failed, return error info instead of throwing
    console.error(`   💀 Page ${pageNumber} conversion failed after ${maxRetries + 1} attempts`);
    
    return {
      base64: null,
      url: null,
      size: 0,
      path: null,
      fileName: null,
      success: false,
      error: error.message,
      pageNumber: pageNumber,
      retriesExhausted: true
    };
  }
};

// Enhanced PDF page count with validation
exports.getPDFPageCount = async (pdfPath) => {
  try {
    // Validate PDF file
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`PDF file not found: ${pdfPath}`);
    }
    
    const pdfStats = fs.statSync(pdfPath);
    if (pdfStats.size === 0) {
      throw new Error(`PDF file is empty: ${pdfPath}`);
    }
    
    if (pdfStats.size > 100 * 1024 * 1024) { // 100MB limit
      throw new Error(`PDF file too large: ${(pdfStats.size / 1024 / 1024).toFixed(1)}MB. Maximum allowed: 100MB`);
    }
    
    const command = `pdfinfo "${pdfPath}"`;
    const { stdout, stderr } = await execPromise(command, {
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });
    
    if (stderr && !stderr.includes('Warning')) {
      console.log(`PDF info warnings: ${stderr}`);
    }
    
    const match = stdout.match(/Pages:\s+(\d+)/);
    if (match) {
      const pageCount = parseInt(match[1]);
      
      if (pageCount <= 0) {
        throw new Error('PDF has no pages');
      }
      
      if (pageCount > 500) {
        throw new Error(`PDF has too many pages: ${pageCount}. Maximum allowed: 500 pages`);
      }
      
      console.log(`✓ PDF validated: ${pageCount} pages, ${(pdfStats.size / 1024 / 1024).toFixed(1)}MB`);
      return pageCount;
    }
    
    throw new Error('Could not determine page count from PDF info');
  } catch (error) {
    console.error('Error getting PDF page count:', error.message);
    throw new Error(`PDF validation failed: ${error.message}`);
  }
};

// Validate PDF file integrity
exports.validatePDF = async (pdfPath) => {
  try {
    // Basic file checks
    if (!fs.existsSync(pdfPath)) {
      throw new Error('PDF file not found');
    }
    
    const stats = fs.statSync(pdfPath);
    if (stats.size === 0) {
      throw new Error('PDF file is empty');
    }
    
    // Check if it's actually a PDF
    const buffer = Buffer.alloc(8);
    const fd = fs.openSync(pdfPath, 'r');
    fs.readSync(fd, buffer, 0, 8, 0);
    fs.closeSync(fd);
    
    const header = buffer.toString('ascii', 0, 4);
    if (header !== '%PDF') {
      throw new Error('File is not a valid PDF (missing PDF header)');
    }
    
    // Try to get page count as validation
    await exports.getPDFPageCount(pdfPath);
    
    return true;
  } catch (error) {
    throw new Error(`PDF validation failed: ${error.message}`);
  }
};

// Cleanup with better error handling
exports.cleanupSessionImages = async (sessionId, userId = null) => {
  try {
    const tempImagesDir = path.join(__dirname, '..', 'temp_images');
    
    if (userId && !sessionStore.validateUserSession(userId, sessionId)) {
      throw new Error('Access denied: Cannot cleanup another user\'s session');
    }
    
    if (!fs.existsSync(tempImagesDir)) {
      console.log(`Temp images directory doesn't exist: ${tempImagesDir}`);
      return { deleted: 0, total: 0 };
    }
    
    const timestamp = sessionId.split('_')[2];
    const files = await fs.promises.readdir(tempImagesDir);
    const sessionImages = files.filter(file => file.includes(`_${timestamp}_`) && file.endsWith('.png'));
    
    if (sessionImages.length === 0) {
      console.log(`No images found for session ${sessionId}`);
      return { deleted: 0, total: 0 };
    }
    
    const deletePromises = sessionImages.map(async (image) => {
      const imagePath = path.join(tempImagesDir, image);
      try {
        await fs.promises.unlink(imagePath);
        return image;
      } catch (error) {
        console.error(`Failed to delete ${image}:`, error.message);
        return null;
      }
    });
    
    const deletedFiles = await Promise.all(deletePromises);
    const successCount = deletedFiles.filter(f => f !== null).length;
    
    if (userId) {
      sessionStore.removeSession(userId, sessionId);
    }
    
    console.log(`🗑️ Cleaned up ${successCount}/${sessionImages.length} session images for ${sessionId}`);
    return { deleted: successCount, total: sessionImages.length };
    
  } catch (error) {
    console.error(`Error cleaning session images for ${sessionId}:`, error.message);
    throw error;
  }
};

// Batch conversion with comprehensive error handling
exports.convertPDFBatchToImages = async (pdfPath, startPage, endPage, sessionId, userId, onProgress) => {
  const results = [];
  const errors = [];
  
  console.log(`Starting batch conversion: pages ${startPage}-${endPage}`);
  
  for (let pageNumber = startPage; pageNumber <= endPage; pageNumber++) {
    try {
      const result = await exports.convertPDFPageToImage(pdfPath, pageNumber, sessionId, userId);
      
      if (result.success) {
        results.push({
          pageNumber: pageNumber,
          base64: result.base64,
          imageUrl: `${process.env.BACKEND_URL || 'http://localhost:5000'}${result.url}`,
          success: true
        });
      } else {
        errors.push({
          pageNumber: pageNumber,
          error: result.error,
          success: false,
          retriesExhausted: result.retriesExhausted
        });
        
        results.push({
          pageNumber: pageNumber,
          base64: null,
          imageUrl: null,
          conversionError: result.error,
          success: false,
          retriesExhausted: result.retriesExhausted
        });
      }
      
      if (onProgress) {
        onProgress(pageNumber - startPage + 1, endPage - startPage + 1, pageNumber);
      }
      
    } catch (error) {
      console.error(`Batch conversion error for page ${pageNumber}:`, error.message);
      
      errors.push({
        pageNumber: pageNumber,
        error: error.message,
        success: false
      });
      
      results.push({
        pageNumber: pageNumber,
        base64: null,
        imageUrl: null,
        conversionError: error.message,
        success: false
      });
    }
  }
  
  const successCount = results.filter(r => r.success).length;
  const errorCount = results.filter(r => !r.success).length;
  
  console.log(`Batch conversion complete: ${successCount} success, ${errorCount} errors`);
  
  return {
    results: results,
    errors: errors,
    successCount: successCount,
    errorCount: errorCount,
    totalPages: endPage - startPage + 1
  };
};
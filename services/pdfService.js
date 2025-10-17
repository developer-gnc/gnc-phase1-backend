const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');

const execPromise = util.promisify(exec);

// Optimized image conversion with better performance
exports.convertPDFPageToImage = async (pdfPath, pageNumber, sessionId = null) => {
  try {
    const tempImagesDir = path.join(__dirname, '..', 'temp_images');
    
    // Use session-specific naming to avoid conflicts between users
    const timestamp = sessionId ? sessionId.split('_')[2] : Date.now();
    const outputPrefix = path.join(tempImagesDir, `page_${pageNumber}_${timestamp}`);
    
    // Optimized pdftocairo command for speed
    // -r 200 instead of 300 for faster processing while maintaining quality
    const command = `pdftocairo -png -f ${pageNumber} -l ${pageNumber} -r 200 -singlefile "${pdfPath}" "${outputPrefix}"`;
    
    const { stdout, stderr } = await execPromise(command, {
      timeout: 30000, // 30 second timeout per page
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    });
    
    if (stderr && !stderr.includes('Syntax Warning')) {
      console.log(`   Warning: ${stderr}`);
    }
    
    const imagePath = `${outputPrefix}.png`;
    
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image not created: ${imagePath}`);
    }
    
    const stats = fs.statSync(imagePath);
    console.log(`   ✓ Page ${pageNumber} converted: ${(stats.size / 1024).toFixed(1)}KB`);
    
    // Read image and convert to base64 efficiently
    const imageBuffer = fs.readFileSync(imagePath);
    const base64 = imageBuffer.toString('base64');
    
    // Return session-specific URL
    const imageFileName = `page_${pageNumber}_${timestamp}.png`;
    
    return {
      base64: `data:image/png;base64,${base64}`,
      url: `/images/${imageFileName}`,
      size: stats.size,
      path: imagePath,
      fileName: imageFileName
    };
    
  } catch (error) {
    console.error(`   ❌ Error converting page ${pageNumber}:`, error.message);
    throw error;
  }
};

// Optimized batch image conversion for maximum speed
exports.convertPDFPagesToImagesParallel = async (pdfPath, sessionId = null, maxConcurrency = 4) => {
  try {
    const pageCount = await exports.getPDFPageCount(pdfPath);
    console.log(`\n🚀 Converting ${pageCount} pages in parallel (concurrency: ${maxConcurrency})`);
    
    const semaphore = Array(maxConcurrency).fill(null).map(() => Promise.resolve());
    let semaphoreIndex = 0;
    
    const conversionPromises = [];
    
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const promise = semaphore[semaphoreIndex].then(async () => {
        try {
          return await exports.convertPDFPageToImage(pdfPath, pageNumber, sessionId);
        } catch (error) {
          return {
            pageNumber,
            error: error.message,
            base64: null,
            imageUrl: null
          };
        }
      });
      
      conversionPromises.push(promise);
      semaphore[semaphoreIndex] = promise;
      semaphoreIndex = (semaphoreIndex + 1) % maxConcurrency;
    }
    
    const conversionResults = await Promise.all(conversionPromises);
    
    console.log(`✅ Batch conversion complete: ${conversionResults.filter(r => !r.error).length}/${pageCount} successful`);
    
    return conversionResults;
    
  } catch (error) {
    console.error('Batch conversion failed:', error);
    throw error;
  }
};

exports.getPDFPageCount = async (pdfPath) => {
  try {
    const command = `pdfinfo "${pdfPath}"`;
    const { stdout } = await execPromise(command, {
      timeout: 10000 // 10 second timeout
    });
    
    const match = stdout.match(/Pages:\s+(\d+)/);
    if (match) {
      return parseInt(match[1]);
    }
    throw new Error('Could not determine page count');
  } catch (error) {
    console.error('Error getting page count:', error);
    throw error;
  }
};

// Fast cleanup session-specific images
exports.cleanupSessionImages = async (sessionId) => {
  try {
    const tempImagesDir = path.join(__dirname, '..', 'temp_images');
    const timestamp = sessionId.split('_')[2];
    
    if (!fs.existsSync(tempImagesDir)) return;
    
    const files = await fs.promises.readdir(tempImagesDir);
    const sessionImages = files.filter(file => file.includes(`_${timestamp}.png`));
    
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
    
    console.log(`🗑️ Cleaned up ${successCount}/${sessionImages.length} session images for ${sessionId}`);
  } catch (error) {
    console.error(`Error cleaning session images for ${sessionId}:`, error.message);
  }
};
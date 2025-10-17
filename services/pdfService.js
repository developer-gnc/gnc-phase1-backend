const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sessionStore = require('./sessionStore');

const execPromise = util.promisify(exec);

exports.convertPDFPageToImage = async (pdfPath, pageNumber, sessionId = null, userId = null) => {
  try {
    const tempImagesDir = path.join(__dirname, '..', 'temp_images');
    
    if (!fs.existsSync(tempImagesDir)) {
      fs.mkdirSync(tempImagesDir, { recursive: true });
    }
    
    // Use the same naming pattern as before but with user hash for security
    const timestamp = sessionId ? sessionId.split('_')[2] : Date.now();
    const userHash = userId ? crypto.createHash('sha256').update(userId).digest('hex').substring(0, 8) : 'unknown';
    const randomComponent = crypto.randomBytes(8).toString('hex');
    
    const outputPrefix = path.join(tempImagesDir, `page_${pageNumber}_${userHash}_${timestamp}_${randomComponent}`);
    
    const command = `pdftocairo -png -f ${pageNumber} -l ${pageNumber} -r 200 -singlefile "${pdfPath}" "${outputPrefix}"`;
    
    const { stdout, stderr } = await execPromise(command, {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024
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
    
    const imageBuffer = fs.readFileSync(imagePath);
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
      path: imagePath,
      fileName: imageFileName
    };
    
  } catch (error) {
    console.error(`   ❌ Error converting page ${pageNumber}:`, error.message);
    throw error;
  }
};

// Keep all other functions exactly the same
exports.cleanupSessionImages = async (sessionId, userId = null) => {
  try {
    const tempImagesDir = path.join(__dirname, '..', 'temp_images');
    
    if (userId && !sessionStore.validateUserSession(userId, sessionId)) {
      throw new Error('Access denied: Cannot cleanup another user\'s session');
    }
    
    if (!fs.existsSync(tempImagesDir)) return;
    
    const timestamp = sessionId.split('_')[2];
    const files = await fs.promises.readdir(tempImagesDir);
    const sessionImages = files.filter(file => file.includes(`_${timestamp}_`) && file.endsWith('.png'));
    
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

exports.getPDFPageCount = async (pdfPath) => {
  try {
    const command = `pdfinfo "${pdfPath}"`;
    const { stdout } = await execPromise(command, {
      timeout: 10000
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
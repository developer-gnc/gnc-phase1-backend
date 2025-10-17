const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');

const execPromise = util.promisify(exec);

exports.convertPDFPageToImage = async (pdfPath, pageNumber) => {
  try {
    console.log(`\nConverting page ${pageNumber} with pdftocairo...`);
    
    const tempImagesDir = path.join(__dirname, '..', 'temp_images');
    const outputPrefix = path.join(tempImagesDir, `page_${pageNumber}`);
    
    const command = `pdftocairo -png -f ${pageNumber} -l ${pageNumber} -r 300 -singlefile "${pdfPath}" "${outputPrefix}"`;
    
    console.log(`   Command: ${command}`);
    
    const { stdout, stderr } = await execPromise(command);
    
    if (stderr && !stderr.includes('Syntax Warning')) {
      console.log(`   Warning: ${stderr}`);
    }
    
    const imagePath = `${outputPrefix}.png`;
    
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image not created: ${imagePath}`);
    }
    
    const stats = fs.statSync(imagePath);
    console.log(`   Image created: ${stats.size} bytes`);
    console.log(`   Path: ${imagePath}`);
    
    const imageBuffer = fs.readFileSync(imagePath);
    const base64 = imageBuffer.toString('base64');
    
    return {
      base64: `data:image/png;base64,${base64}`,
      url: `/images/page_${pageNumber}.png`,
      size: stats.size,
      path: imagePath
    };
    
  } catch (error) {
    console.error(`   Error converting page ${pageNumber}:`, error.message);
    throw error;
  }
};

exports.getPDFPageCount = async (pdfPath) => {
  try {
    const command = `pdfinfo "${pdfPath}"`;
    const { stdout } = await execPromise(command);
    
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
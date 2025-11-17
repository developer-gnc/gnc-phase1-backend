const { GoogleGenerativeAI } = require('@google/generative-ai');

// Load API keys from environment variables
const API_KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
  process.env.GEMINI_API_KEY_5,
  process.env.GEMINI_API_KEY_6,
  process.env.GEMINI_API_KEY_7,
  process.env.GEMINI_API_KEY_8,
  process.env.GEMINI_API_KEY_9,
  process.env.GEMINI_API_KEY_10
].filter(key => key && key.trim() !== '');

if (API_KEYS.length === 0) {
  console.warn('No GEMINI_API_KEY_* found, falling back to GEMINI_API_KEY');
  API_KEYS.push(process.env.GEMINI_API_KEY);
}

console.log(`Loaded ${API_KEYS.length} API key(s) for ultra-fast parallel processing`);

const geminiClients = API_KEYS.map(key => new GoogleGenerativeAI(key));

// NOTE: Prompt will come from frontend - no default prompt needed

// Parse Gemini response with robust error handling
const parseGeminiResponse = (text) => {
  try {
    const cleanText = text.trim();
    
    // Try direct parse
    if (cleanText.startsWith('[') && cleanText.endsWith(']')) {
      const parsed = JSON.parse(cleanText);
      if (Array.isArray(parsed)) {
        return { parsed, error: null };
      }
    }

    // Extract JSON array from text
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        return { parsed, error: null };
      }
    }

    // Empty response is valid - not an error
    return { parsed: [], error: null };
  } catch (e) {
    return { parsed: [], error: `Parse error: ${e.message}` };
  }
};

// Rate limiter for API management
class UltraFastRateLimiter {
  constructor() {
    this.keyUsage = new Map();
    this.maxRequestsPerMinute = 60;
    this.burstLimit = 10;
    this.burstWindow = 10000;
  }

  async waitIfNeeded(keyIndex) {
    const now = Date.now();
    const keyData = this.keyUsage.get(keyIndex) || { 
      requests: [], 
      lastReset: now,
      burstRequests: []
    };
    
    keyData.requests = keyData.requests.filter(time => now - time < 60000);
    keyData.burstRequests = keyData.burstRequests.filter(time => now - time < this.burstWindow);
    
    if (keyData.burstRequests.length >= this.burstLimit) {
      const oldestBurst = keyData.burstRequests[0];
      const burstWaitTime = this.burstWindow - (now - oldestBurst) + 100;
      
      if (burstWaitTime > 0) {
        console.log(`   âš¡ Burst limit: waiting ${Math.ceil(burstWaitTime/1000)}s for key ${keyIndex + 1}`);
        await new Promise(resolve => setTimeout(resolve, burstWaitTime));
        return this.waitIfNeeded(keyIndex);
      }
    }
    
    if (keyData.requests.length >= this.maxRequestsPerMinute) {
      const oldestRequest = keyData.requests[0];
      const waitTime = 60000 - (now - oldestRequest) + 200;
      
      if (waitTime > 0) {
        console.log(`   â³ Rate limit: waiting ${Math.ceil(waitTime/1000)}s for key ${keyIndex + 1}`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return this.waitIfNeeded(keyIndex);
      }
    }

    keyData.requests.push(now);
    keyData.burstRequests.push(now);
    this.keyUsage.set(keyIndex, keyData);
  }

  getBestAvailableKey() {
    const now = Date.now();
    let bestKey = 0;
    let leastUsage = Infinity;
    
    for (let i = 0; i < API_KEYS.length; i++) {
      const keyData = this.keyUsage.get(i) || { requests: [], burstRequests: [] };
      const recentRequests = keyData.requests.filter(time => now - time < 60000);
      const recentBursts = keyData.burstRequests.filter(time => now - time < 10000);
      
      const usage = recentRequests.length + (recentBursts.length * 2);
      
      if (usage < leastUsage) {
        leastUsage = usage;
        bestKey = i;
      }
    }
    
    return bestKey;
  }
}

const ultraFastLimiter = new UltraFastRateLimiter();

// Single image analysis with model and prompt from frontend
const analyzeSingleImage = async (base64Data, pageNumber, keyIndex, modelName = 'gemini-2.0-flash', prompt) => {
  // Prompt is required from frontend
  if (!prompt) {
    throw new Error('Prompt is required from frontend');
  }

  await ultraFastLimiter.waitIfNeeded(keyIndex);
  
  const genAI = geminiClients[keyIndex];
  const model = genAI.getGenerativeModel({ model: modelName });

  if (!base64Data.startsWith('data:image')) {
    base64Data = `data:image/png;base64,${base64Data.replace(/^data:image\/[a-z]+;base64,/, '')}`;
  }

  const base64Part = base64Data.split(',')[1];
  
  const imagePart = {
    inlineData: {
      data: base64Part,
      mimeType: "image/png",
    },
  };

  const result = await model.generateContent([prompt, imagePart]);
  const response = await result.response;
  const text = response.text();

  return parseGeminiResponse(text);
};

// Retry mechanism
const retryWithFallback = async (fn, pageNumber, maxRetries = 2) => {
  let lastError = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const keyIndex = ultraFastLimiter.getBestAvailableKey();
      return await fn(keyIndex);
    } catch (error) {
      lastError = error;
      const isRetryable = error.message.includes('429') || 
                         error.message.includes('quota') || 
                         error.message.includes('rate') ||
                         error.message.includes('fetch') ||
                         error.message.includes('network');

      if (isRetryable && attempt < maxRetries - 1) {
        const delay = 200 + (attempt * 300);
        console.log(`   ðŸ”„ Fast retry ${attempt + 1}/${maxRetries} for page ${pageNumber} after ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      break;
    }
  }
  
  throw lastError;
};

// Single image analysis (prompt required from frontend)
exports.analyzeImage = async (imageBase64, pageNumber, modelName = 'gemini-2.0-flash', prompt) => {
  if (!prompt) {
    throw new Error('Prompt is required from frontend');
  }
  
  return await retryWithFallback(
    async (keyIndex) => {
      return await analyzeSingleImage(imageBase64, pageNumber, keyIndex, modelName, prompt);
    },
    pageNumber
  );
};

// Batch image analysis with model and prompt from frontend
exports.analyzeImagesUltraFast = async (images, onProgress, modelName = 'gemini-2.0-flash', prompt) => {
  // Prompt is required from frontend
  if (!prompt) {
    throw new Error('Prompt is required from frontend');
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`ULTRA-FAST PARALLEL ANALYSIS STARTING`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Total images: ${images.length}`);
  console.log(`API Keys: ${API_KEYS.length}`);
  console.log(`Model: ${modelName}`);
  console.log(`Prompt from frontend: Yes`);
  console.log(`Max parallel: ${API_KEYS.length * 8} (8x per key)`);
  console.log(`${'='.repeat(70)}\n`);
  
  const results = new Array(images.length).fill(null);
  let completedCount = 0;
  const startTime = Date.now();
  
  const MAX_CONCURRENT = API_KEYS.length * 8;
  
  const processImage = async (image, index) => {
    const imageStartTime = Date.now();
    
    try {
      const result = await retryWithFallback(
        async (keyIndex) => {
          return await analyzeSingleImage(
            image.base64, 
            image.pageNumber, 
            keyIndex, 
            modelName,
            prompt
          );
        },
        image.pageNumber
      );

      results[index] = {
        parsed: result.parsed,
        raw: JSON.stringify(result.parsed),
        error: result.error
      };

      completedCount++;
      const processingTime = Date.now() - imageStartTime;
      
      if (onProgress) {
        onProgress(completedCount, images.length, image.pageNumber);
      }

      if (result.parsed.length > 0) {
        console.log(`   âš¡ Page ${image.pageNumber} - ${result.parsed.length} items (${processingTime}ms)`);
      } else if (result.error) {
        console.log(`   âš ï¸ Page ${image.pageNumber} - Error: ${result.error.substring(0, 30)}...`);
      } else {
        console.log(`   âœ“ Page ${image.pageNumber} - Empty (${processingTime}ms)`);
      }

    } catch (error) {
      console.error(`   âŒ Page ${image.pageNumber} - Failed: ${error.message.substring(0, 30)}...`);
      
      results[index] = {
        parsed: [],
        raw: `Error: ${error.message}`,
        error: error.message
      };

      completedCount++;
      if (onProgress) {
        onProgress(completedCount, images.length, image.pageNumber);
      }
    }
  };

  // Process with controlled concurrency
  const processingPromises = [];
  
  for (let i = 0; i < images.length; i += MAX_CONCURRENT) {
    const batch = images.slice(i, i + MAX_CONCURRENT);
    const batchPromises = batch.map((image, batchIndex) => 
      processImage(image, i + batchIndex)
    );
    
    processingPromises.push(...batchPromises);
    
    if (i + MAX_CONCURRENT < images.length) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  await Promise.all(processingPromises);

  const endTime = Date.now();
  const totalTime = (endTime - startTime) / 1000;
  const successCount = results.filter(r => r.parsed.length > 0).length;
  const emptyCount = results.filter(r => r.parsed.length === 0 && !r.error).length;
  const errorCount = results.filter(r => r.error).length;
  const totalItems = results.reduce((sum, r) => sum + r.parsed.length, 0);
  const pagesPerMinute = (images.length / totalTime) * 60;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`ULTRA-FAST ANALYSIS COMPLETE`);
  console.log(`${'='.repeat(70)}`);
  console.log(`âœ… Pages with data: ${successCount}/${images.length}`);
  console.log(`âœ“ Empty pages: ${emptyCount}/${images.length}`);
  console.log(`âŒ Errors: ${errorCount}/${images.length}`);
  console.log(`ðŸ“Š Total items extracted: ${totalItems}`);
  console.log(`âš¡ Total time: ${totalTime.toFixed(1)}s`);
  console.log(`ðŸš€ Speed: ${pagesPerMinute.toFixed(1)} pages/minute`);
  console.log(`ðŸŽ¯ Error rate: ${((errorCount / images.length) * 100).toFixed(1)}%`);
  console.log(`ðŸ¤– Model used: ${modelName}`);
  console.log(`ðŸ“ Prompt from frontend: Yes`);
  console.log(`${'='.repeat(70)}\n`);
  
  return results;
};

// Backward compatibility exports
exports.analyzeImagesOptimized = exports.analyzeImagesUltraFast;
exports.analyzeImagesParallel = exports.analyzeImagesUltraFast;

// Get available models
exports.getAvailableModels = () => {
  return [
    'gemini-2.0-flash',
    'gemini-2.5-flash',
    'gemini-2.5-pro'
  ];
};

// Validate model
exports.validateModel = (modelName) => {
  const availableModels = exports.getAvailableModels();
  return availableModels.includes(modelName);
};

// Get default prompt (for frontend reference)
exports.getDefaultPrompt = () => {
  return DEFAULT_EXTRACTION_PROMPT;
};
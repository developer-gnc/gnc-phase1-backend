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

// Enhanced extraction prompt
const EXTRACTION_PROMPT = `You are a data extraction specialist. Extract information from this invoice/document image and categorize it into one of these categories:
1. Labour
2. Material
3. Equipment
4. Consumables
5. Subtrade
6. LabourTimesheet
7. EquipmentLog

For each item found, extract ALL available fields and return a JSON object with:
- category: (Labour/Material/Equipment/Consumables/Subtrade/LabourTimesheet/EquipmentLog)
- data: object containing all extracted fields

CATEGORY CLASSIFICATION RULES:
- Labour: Use when labour data contains price/cost/amount fields (UNITRATE, TOTALAMOUNT, etc.)
- LabourTimesheet: Use when labour data does NOT contain any price/cost/amount fields (just time tracking)
- Equipment: Use when equipment data contains price/cost/amount fields (UNITRATE, TOTALAMOUNT, etc.)
- EquipmentLog: Use when equipment data does NOT contain any price/cost/amount fields (just usage tracking)

LABOUR fields (extract if present - ALL FIELD NAMES MUST BE CAPITAL):
- SRNO, DATE, DAY, INVOICENO, EMPLOYEENAME, EMPLOYEECODE, POSITION, ITEMDESCRIPTION
- TOTALHOURS, TOTALHOURSMANUAL, BACKUPHOURS
- VARIANCE, UOM, UNITRATE, REGULARHOURS, OVERTIMEHOURS, DOUBLEOVERTIMEHOURS, TOTALAMOUNT

LABOUR TIMESHEET fields (extract if present - NO PRICE FIELDS - ALL FIELD NAMES MUST BE CAPITAL):
- SRNO, DATE, DAY, EMPLOYEENAME, EMPLOYEECODE, POSITION, ITEMDESCRIPTION
- TIMEIN, TIMEOUT, LUNCHBREAK, TOTALHOURS, TOTALHOURSMANUAL, BACKUPHOURS
- VARIANCE, REGULARHOURS, OVERTIMEHOURS, DOUBLEOVERTIMEHOURS

MATERIAL/CONSUMABLES fields (extract if present - ALL FIELD NAMES MUST BE CAPITAL):
- SRNO, DATE, DAY, INVOICENO, ITEM, CATEGORY, ITEMDESCRIPTION
- QTY, BACKUPQTY, VARIANCE, UOM, UNITRATE, TOTALAMOUNT

EQUIPMENT fields (extract if present - ALL FIELD NAMES MUST BE CAPITAL):
- SRNO, DATE, DAY, INVOICENO, ITEM, CATEGORY, ITEMDESCRIPTION
- QTY, BACKUPQTY, VARIANCE, UOM, UNITRATE, TOTALAMOUNT

EQUIPMENT LOG fields (extract if present - NO PRICE FIELDS - ALL FIELD NAMES MUST BE CAPITAL):
- SRNO, DATE, DAY, ITEM, CATEGORY, ITEMDESCRIPTION, OPERATORNAME
- QTY, BACKUPQTY, VARIANCE, UOM, HOURSUSED, STARTTIME, ENDTIME

SUBTRADE fields (extract if present - ALL FIELD NAMES MUST BE CAPITAL):
- SRNO, DATE, DAY, INVOICENO, ITEM, CATEGORY, VENDORNAME, ITEMDESCRIPTION
- QTY, BACKUPQTY, UOM, UNITRATE, TOTALAMOUNT

IMPORTANT RULES:
1. Extract ALL text visible in the image
2. If a field is not present, omit it from the JSON
3. Return ONLY valid JSON array format: [{"category": "...", "data": {...}}, ...]
4. If multiple items are present, return multiple objects in the array
5. Use exact field names as specified above (ALL CAPITAL LETTERS)
6. For numeric values, extract as numbers not strings
7. For dates, use format: YYYY-MM-DD or as shown in document
8. For time fields, use format: HH:MM or as shown in document
9. If the page is blank or has no extractable data, return an empty array: []
10. Sometimes amount is there but quantity is not there than give it as TOTALAMOUNT.
11. If total amount is mention with some other naming convention than give TOTALAMOUNT again with key as TOTALAMOUNT but it should be compulsory to have TOTALAMOUNT key in each json object with precised value.
12. Fetch quantity, unit rate and total amount carefully, but if just unit amount and quantity is there but total amount is not there calculate TOTALAMOUNT and give.
13. CRITICAL: Check if data contains price/cost/amount fields:
    - If Labour data has TIMEIN and TIMEOUT fields than it will be in "LabourTimesheet" else it will be in normal "Labour" category.
    - If Equipment data has UNITRATE, TOTALAMOUNT, or similar price fields → category: "Equipment"
    - If Equipment data has NO price fields (only usage tracking) → category: "EquipmentLog"
14. Fetch taxes and all other details related to a json for each image.
15. If there is any heading like summary or recap above a table or rows of data in image than do not consider data below that heading into json.
16. CRITICAL: ALL FIELD NAMES IN THE DATA OBJECT MUST BE IN CAPITAL LETTERS (e.g., EMPLOYEENAME, TOTALAMOUNT, UNITRATE)
17. if there a heading on table or category above rows of data and it look like a category than add it as sub category in data json for these rows.
18. Format for all type the date should be DD-MM-YYYY.
19. if there ther any invoice date and invoice number is there on image include that in every data json object but not as a separate object.
Return ONLY the JSON array, no explanations or additional text.`;

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

// ULTRA-FAST: Advanced rate limiter with aggressive limits
class UltraFastRateLimiter {
  constructor() {
    this.keyUsage = new Map(); // keyIndex -> { requests: [], lastReset: timestamp }
    this.maxRequestsPerMinute = 60; // AGGRESSIVE: 60 requests per minute per key
    this.burstLimit = 10; // Allow 10 requests in quick succession
    this.burstWindow = 10000; // 10 seconds burst window
  }

  async waitIfNeeded(keyIndex) {
    const now = Date.now();
    const keyData = this.keyUsage.get(keyIndex) || { 
      requests: [], 
      lastReset: now,
      burstRequests: []
    };
    
    // Clean old requests (older than 1 minute)
    keyData.requests = keyData.requests.filter(time => now - time < 60000);
    keyData.burstRequests = keyData.burstRequests.filter(time => now - time < this.burstWindow);
    
    // Check burst limit first (allows quick bursts)
    if (keyData.burstRequests.length >= this.burstLimit) {
      const oldestBurst = keyData.burstRequests[0];
      const burstWaitTime = this.burstWindow - (now - oldestBurst) + 100;
      
      if (burstWaitTime > 0) {
        console.log(`   ⚡ Burst limit: waiting ${Math.ceil(burstWaitTime/1000)}s for key ${keyIndex + 1}`);
        await new Promise(resolve => setTimeout(resolve, burstWaitTime));
        return this.waitIfNeeded(keyIndex);
      }
    }
    
    // Check overall rate limit
    if (keyData.requests.length >= this.maxRequestsPerMinute) {
      const oldestRequest = keyData.requests[0];
      const waitTime = 60000 - (now - oldestRequest) + 200; // Reduced buffer
      
      if (waitTime > 0) {
        console.log(`   ⏳ Rate limit: waiting ${Math.ceil(waitTime/1000)}s for key ${keyIndex + 1}`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return this.waitIfNeeded(keyIndex);
      }
    }
    
    // Record this request
    keyData.requests.push(now);
    keyData.burstRequests.push(now);
    this.keyUsage.set(keyIndex, keyData);
  }

  // Get the best available key (least loaded)
  getBestAvailableKey() {
    const now = Date.now();
    let bestKey = 0;
    let minRequests = Infinity;
    
    for (let i = 0; i < API_KEYS.length; i++) {
      const keyData = this.keyUsage.get(i) || { requests: [], burstRequests: [] };
      const recentRequests = keyData.requests.filter(time => now - time < 60000);
      const recentBursts = keyData.burstRequests.filter(time => now - time < this.burstWindow);
      
      // Prioritize keys with fewer recent requests and burst capacity
      const load = recentRequests.length + (recentBursts.length * 2);
      
      if (load < minRequests) {
        minRequests = load;
        bestKey = i;
      }
    }
    
    return bestKey;
  }
}

const ultraFastLimiter = new UltraFastRateLimiter();

// Analyze single image with ultra-fast processing and model selection
const analyzeSingleImageUltraFast = async (imageBase64, pageNumber, keyIndex = null, modelName = 'gemini-2.0-flash') => {
  // Auto-select best key if not specified
  if (keyIndex === null) {
    keyIndex = ultraFastLimiter.getBestAvailableKey();
  }
  
  // Wait for rate limit if needed (optimized waiting)
  await ultraFastLimiter.waitIfNeeded(keyIndex);

  const model = geminiClients[keyIndex].getGenerativeModel({ 
    model: modelName  // Use the specified model
  });

  const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  const imagePart = {
    inlineData: {
      data: base64Data,
      mimeType: "image/png",
    },
  };

  const result = await model.generateContent([EXTRACTION_PROMPT, imagePart]);
  const response = await result.response;
  const text = response.text();

  return parseGeminiResponse(text);
};

// ULTRA-FAST: Minimal retry with immediate key rotation
const retryUltraFast = async (fn, pageNumber, maxRetries = 2) => {
  let lastError = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Try with the best available key for each attempt
      const keyIndex = ultraFastLimiter.getBestAvailableKey();
      return await fn(keyIndex);
    } catch (error) {
      lastError = error;
      const isRetryable = error.message.includes('429') || 
                         error.message.includes('quota') || 
                         error.message.includes('rate') ||
                         error.message.includes('fetch') ||
                         error.message.includes('network');

      // Quick retry only for retryable errors
      if (isRetryable && attempt < maxRetries - 1) {
        const delay = 200 + (attempt * 300); // Fast retry: 200ms, 500ms
        console.log(`   🔄 Fast retry ${attempt + 1}/${maxRetries} for page ${pageNumber} after ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      break;
    }
  }
  
  throw lastError;
};

// ULTRA-FAST: Maximum parallel processing with intelligent load balancing and model selection
exports.analyzeImagesUltraFast = async (images, onProgress, modelName = 'gemini-2.0-flash') => {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`ULTRA-FAST PARALLEL ANALYSIS STARTING`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Total images: ${images.length}`);
  console.log(`API Keys: ${API_KEYS.length}`);
  console.log(`Model: ${modelName}`);
  console.log(`Max parallel: ${API_KEYS.length * 8} (8x per key)`); // AGGRESSIVE: 8x per key
  console.log(`Target speed: ${Math.min(60, images.length)} pages/minute`);
  console.log(`${'='.repeat(70)}\n`);
  
  const results = new Array(images.length).fill(null);
  let completedCount = 0;
  const startTime = Date.now();
  
  // ULTRA-FAST: Maximum concurrency
  const MAX_CONCURRENT = API_KEYS.length * 8; // 8 requests per key simultaneously
  
  // Process images with maximum concurrency
  const processImage = async (image, index) => {
    const imageStartTime = Date.now();
    
    try {
      const result = await retryUltraFast(
        async (keyIndex) => {
          return await analyzeSingleImageUltraFast(image.base64, image.pageNumber, keyIndex, modelName);
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
        console.log(`   ⚡ Page ${image.pageNumber} - ${result.parsed.length} items (${processingTime}ms)`);
      } else if (result.error) {
        console.log(`   ⚠️ Page ${image.pageNumber} - Error: ${result.error.substring(0, 30)}...`);
      } else {
        console.log(`   ✓ Page ${image.pageNumber} - Empty (${processingTime}ms)`);
      }

    } catch (error) {
      console.error(`   ❌ Page ${image.pageNumber} - Failed: ${error.message.substring(0, 30)}...`);
      
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

  // ULTRA-FAST: Process ALL images simultaneously with controlled batching
  const processingPromises = [];
  
  for (let i = 0; i < images.length; i += MAX_CONCURRENT) {
    const batch = images.slice(i, i + MAX_CONCURRENT);
    const batchPromises = batch.map((image, batchIndex) => 
      processImage(image, i + batchIndex)
    );
    
    // Start batch immediately without waiting
    processingPromises.push(...batchPromises);
    
    // Small stagger between batch starts to prevent overload
    if (i + MAX_CONCURRENT < images.length) {
      await new Promise(resolve => setTimeout(resolve, 50)); // Minimal delay
    }
  }

  // Wait for ALL processing to complete
  await Promise.all(processingPromises);

  // Calculate final statistics
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
  console.log(`✅ Pages with data: ${successCount}/${images.length}`);
  console.log(`✓ Empty pages: ${emptyCount}/${images.length}`);
  console.log(`❌ Errors: ${errorCount}/${images.length}`);
  console.log(`📊 Total items extracted: ${totalItems}`);
  console.log(`⚡ Total time: ${totalTime.toFixed(1)}s`);
  console.log(`🚀 Speed: ${pagesPerMinute.toFixed(1)} pages/minute`);
  console.log(`🎯 Error rate: ${((errorCount / images.length) * 100).toFixed(1)}%`);
  console.log(`🤖 Model used: ${modelName}`);
  console.log(`${'='.repeat(70)}\n`);
  
  return results;
};

// Default export (uses ultra-fast)
exports.analyzeImagesOptimized = exports.analyzeImagesUltraFast;

// Backward compatibility
exports.analyzeImagesParallel = exports.analyzeImagesUltraFast;

// Single image analysis with model selection
exports.analyzeImage = async (imageBase64, pageNumber, modelName = 'gemini-2.0-flash') => {
  return await retryUltraFast(
    async (keyIndex) => {
      return await analyzeSingleImageUltraFast(imageBase64, pageNumber, keyIndex, modelName);
    },
    pageNumber
  );
};
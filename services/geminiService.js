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
  console.warn('⚠️ No GEMINI_API_KEY_* found, falling back to GEMINI_API_KEY');
  API_KEYS.push(process.env.GEMINI_API_KEY);
}

console.log(`🔑 Loaded ${API_KEYS.length} API key(s) for maximum parallel processing`);

const geminiClients = API_KEYS.map(key => new GoogleGenerativeAI(key));

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
- Labour: Use when labour data contains price/cost/amount fields (unitRate, totalAmount, etc.)
- LabourTimesheet: Use when labour data does NOT contain any price/cost/amount fields (just time tracking)
- Equipment: Use when equipment data contains price/cost/amount fields (unitRate, totalAmount, etc.)
- EquipmentLog: Use when equipment data does NOT contain any price/cost/amount fields (just usage tracking)

LABOUR fields (extract if present):
- srNo, date, day, invoiceNo, employeeName, employeeCode, position, itemDescription
- totalHours, totalHoursManual, backupHours
- variance, uom, unitRate, regularHours, overtimeHours, doubleOvertimeHours

LABOUR TIMESHEET fields (extract if present - NO PRICE FIELDS):
- srNo, date, day, employeeName, employeeCode, position, itemDescription
- timeIn, timeOut, lunchBreak, totalHours, totalHoursManual, backupHours
- variance, regularHours, overtimeHours, doubleOvertimeHours

MATERIAL/CONSUMABLES fields (extract if present):
- srNo, date, day, invoiceNo, item, category, itemDescription
- qty, backupQty, variance, uom, unitRate

EQUIPMENT fields (extract if present):
- srNo, date, day, invoiceNo, item, category, itemDescription
- qty, backupQty, variance, uom, unitRate

EQUIPMENT LOG fields (extract if present - NO PRICE FIELDS):
- srNo, date, day, item, category, itemDescription, operatorName
- qty, backupQty, variance, uom, hoursUsed, startTime, endTime

SUBTRADE fields (extract if present):
- srNo, date, day, invoiceNo, item, category, vendorName, itemDescription
- qty, backupQty, uom, unitRate

IMPORTANT RULES:
1. Extract ALL text visible in the image
2. If a field is not present, omit it from the JSON
3. Return ONLY valid JSON array format: [{"category": "...", "data": {...}}, ...]
4. If multiple items are present, return multiple objects in the array
5. Use exact field names as specified above (camelCase)
6. For numeric values, extract as numbers not strings
7. For dates, use format: YYYY-MM-DD or as shown in document
8. For time fields, use format: HH:MM or as shown in document
9. If the page is blank or has no extractable data, return an empty array: []
10. Sometimes amount is there but quantity is not there than give it as total amount.
11. If total amount is mention with some other naming convention than give totalamount again with key as total amount but it should be compulsory to have total amount key in each json object with precised value.
12. Fetch quantity, unit rate and total amount carefully, but if just unit amount and quantity is there but total amount is not there calculate totalamount and give.
13. CRITICAL: Check if data contains price/cost/amount fields:
   
    - If Labour data has time in and time out fields than it will be in "LabourTimesheet" else it will be in normal "Labour" category.
    - If Equipment data has unitRate, totalAmount, or similar price fields → category: "Equipment"
    - If Equipment data has NO price fields (only usage tracking) → category: "EquipmentLog"
14. Fetech taxes and all other details related to a json for each image.

Return ONLY the JSON array, no explanations or additional text.`;

// Parse Gemini response
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

// Analyze single image with specific API key
const analyzeSingleImage = async (imageBase64, pageNumber, keyIndex) => {
  const model = geminiClients[keyIndex].getGenerativeModel({ 
    model: "gemini-2.0-flash"
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

// Optimized retry with faster recovery
const retryWithBackoff = async (fn, maxRetries = 2, baseDelay = 500) => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isRateLimit = error.message.includes('429') || 
                         error.message.includes('quota') || 
                         error.message.includes('rate');
      
      const isNetworkError = error.message.includes('fetch') ||
                            error.message.includes('network') ||
                            error.message.includes('ECONNREFUSED');

      // Only retry on rate limits or network errors
      if ((isRateLimit || isNetworkError) && attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(1.5, attempt); // Faster backoff
        console.log(`   ⏳ Quick retry ${attempt + 1}/${maxRetries} after ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      throw error;
    }
  }
};

// ULTRA-FAST parallel processing with intelligent load balancing
exports.analyzeImagesParallel = async (images, onProgress) => {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`ULTRA-FAST PARALLEL ANALYSIS STARTING`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Total images: ${images.length}`);
  console.log(`API Keys: ${API_KEYS.length}`);
  console.log(`Max concurrent requests: ${API_KEYS.length * 3}`); // 3x concurrency per key
  console.log(`${'='.repeat(70)}\n`);
  
  const results = new Array(images.length).fill(null);
  let completedCount = 0;
  const failedIndices = new Set();

  // Process all images with maximum concurrency (3 requests per API key)
  const processImage = async (image, index) => {
    const keyIndex = index % API_KEYS.length;
    
    try {
      const result = await retryWithBackoff(async () => {
        return await analyzeSingleImage(image.base64, image.pageNumber, keyIndex);
      });

      results[index] = {
        parsed: result.parsed,
        raw: JSON.stringify(result.parsed),
        error: result.error
      };

      completedCount++;
      if (onProgress) {
        onProgress(completedCount, images.length, image.pageNumber);
      }

      if (result.parsed.length > 0) {
        console.log(`   ✅ Page ${image.pageNumber} - ${result.parsed.length} items (Key ${keyIndex + 1})`);
      } else if (result.error) {
        console.log(`   ⚠️ Page ${image.pageNumber} - Error: ${result.error.substring(0, 50)}...`);
      } else {
        console.log(`   ✓ Page ${image.pageNumber} - Empty page`);
      }

    } catch (error) {
      console.error(`   ❌ Page ${image.pageNumber} - Failed: ${error.message.substring(0, 50)}...`);
      
      failedIndices.add(index);
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

  // Process ALL images simultaneously with maximum concurrency
  const concurrencyLimit = API_KEYS.length * 3; // 3x per API key
  const processingPromises = [];
  
  for (let i = 0; i < images.length; i += concurrencyLimit) {
    const batch = images.slice(i, i + concurrencyLimit);
    const batchPromises = batch.map((image, batchIndex) => 
      processImage(image, i + batchIndex)
    );
    
    processingPromises.push(...batchPromises);
  }

  // Wait for ALL analysis to complete simultaneously
  await Promise.all(processingPromises);

  // Quick retry for failed pages with different keys (parallel)
  if (failedIndices.size > 0 && API_KEYS.length > 1) {
    console.log(`\n🔄 Quick parallel retry for ${failedIndices.size} failed pages...`);

    const retryPromises = Array.from(failedIndices).map(async (index) => {
      const image = images[index];
      // Use different key for retry
      const originalKey = index % API_KEYS.length;
      const retryKey = (originalKey + 1) % API_KEYS.length;

      try {
        const result = await retryWithBackoff(async () => {
          return await analyzeSingleImage(image.base64, image.pageNumber, retryKey);
        }, 1, 200); // Single quick retry

        results[index] = {
          parsed: result.parsed,
          raw: JSON.stringify(result.parsed),
          error: result.error
        };

        if (result.parsed.length > 0) {
          console.log(`   ✅ Page ${image.pageNumber} - Recovered ${result.parsed.length} items`);
        }
      } catch (error) {
        console.error(`   ❌ Page ${image.pageNumber} - Retry failed`);
        // Keep original error result
      }
    });

    await Promise.all(retryPromises);
  }

  // Calculate final statistics
  const successCount = results.filter(r => r.parsed.length > 0).length;
  const emptyCount = results.filter(r => r.parsed.length === 0 && !r.error).length;
  const errorCount = results.filter(r => r.error).length;
  const totalItems = results.reduce((sum, r) => sum + r.parsed.length, 0);

  const processingTime = process.hrtime ? process.hrtime()[0] : 'unknown';

  console.log(`\n${'='.repeat(70)}`);
  console.log(`ULTRA-FAST ANALYSIS COMPLETE`);
  console.log(`${'='.repeat(70)}`);
  console.log(`✅ Pages with data: ${successCount}/${images.length}`);
  console.log(`✓ Empty pages: ${emptyCount}/${images.length}`);
  console.log(`❌ Errors: ${errorCount}/${images.length}`);
  console.log(`📊 Total items extracted: ${totalItems}`);
  console.log(`⚡ Processing time: ~${processingTime}s`);
  console.log(`🚀 Avg speed: ${(images.length / Math.max(processingTime, 1)).toFixed(1)} pages/sec`);
  console.log(`${'='.repeat(70)}\n`);
  
  return results;
};

// Single image analysis (backward compatibility)
exports.analyzeImage = async (imageBase64, pageNumber) => {
  return await retryWithBackoff(async () => {
    return await analyzeSingleImage(imageBase64, pageNumber, 0);
  });
};
const { GoogleGenerativeAI } = require('@google/generative-ai');
const RequestQueue = require('../utils/RequestQueue');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiQueue = new RequestQueue(10);

const EXTRACTION_PROMPT = `You are a data extraction specialist. Extract information from this invoice/document image and categorize it into one of these categories:
1. Labour
2. Material
3. Equipment
4. Consumables
5. Subtrade

For each item found, extract ALL available fields and return a JSON object with:
- category: (Labour/Material/Equipment/Consumables/Subtrade)
- data: object containing all extracted fields

LABOUR fields (extract if present):
- srNo, date, day, invoiceNo, employeeName, employeeCode, position, itemDescription
- timeIn, timeOut, lunchBreak, totalHours, totalHoursManual, backupHours
- variance, uom, unitRate, regularHours, overtimeHours, doubleOvertimeHours

MATERIAL/EQUIPMENT/CONSUMABLES fields (extract if present):
- srNo, date, day, invoiceNo, item, category, itemDescription
- qty, backupQty, variance, uom, unitRate

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

Return ONLY the JSON array, no explanations or additional text.`;

exports.analyzeImage = async (imageBase64, pageNumber) => {
  return geminiQueue.add(async () => {
    try {
      console.log(`\nAnalyzing Page ${pageNumber} with Gemini...`);
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      console.log(`   Image size: ${base64Data.length} characters`);

      const imagePart = {
        inlineData: {
          data: base64Data,
          mimeType: "image/png",
        },
      };

      console.log(`   Sending to Gemini...`);
      const startTime = Date.now();
      
      const result = await model.generateContent([EXTRACTION_PROMPT, imagePart]);
      const response = await result.response;
      const text = response.text();
      
      const elapsed = Date.now() - startTime;
      console.log(`   Response received in ${elapsed}ms`);
      console.log(`   Response length: ${text.length} characters`);

      let parsed = [];
      let parseError = null;

      try {
        const cleanText = text.trim();
        if (cleanText.startsWith('[') && cleanText.endsWith(']')) {
          parsed = JSON.parse(cleanText);
          console.log(`   Successfully parsed ${parsed.length} items`);
          return { parsed, raw: text, error: null };
        }
      } catch (e) {
        console.log(`   Direct parse failed: ${e.message}`);
      }

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
          console.log(`   Successfully parsed ${parsed.length} items`);
          return { parsed, raw: text, error: null };
        } catch (e) {
          console.log(`   JSON parse error: ${e.message}`);
          parseError = e.message;
          
          let jsonStr = jsonMatch[0];
          let lastValidIndex = jsonStr.lastIndexOf('},');
          if (lastValidIndex > 0) {
            jsonStr = jsonStr.substring(0, lastValidIndex + 1) + ']';
            try {
              parsed = JSON.parse(jsonStr);
              console.log(`   Recovered ${parsed.length} items (fixed truncation)`);
              return { 
                parsed, 
                raw: text, 
                error: `Warning: JSON was truncated. Recovered ${parsed.length} items.`
              };
            } catch (e2) {
              console.log(`   Truncation fix failed`);
            }
          }
        }
      }

      const objectRegex = /\{\s*"category"\s*:\s*"[^"]+"\s*,\s*"data"\s*:\s*\{[^}]+\}\s*\}/g;
      const matches = [...text.matchAll(objectRegex)];
      
      for (const match of matches) {
        try {
          const obj = JSON.parse(match[0]);
          if (obj.category && obj.data) {
            parsed.push(obj);
          }
        } catch (e) {
          // Skip invalid objects
        }
      }

      if (parsed.length > 0) {
        console.log(`   Recovered ${parsed.length} items from patterns`);
        return { 
          parsed, 
          raw: text, 
          error: `Warning: Extracted ${parsed.length} items using fallback parsing.`
        };
      }

      console.warn(`   Could not parse any valid JSON from response`);
      return { 
        parsed: [], 
        raw: text, 
        error: `Error: Could not parse JSON. ${parseError || 'No JSON found in response.'}`
      };

    } catch (error) {
      console.error(`   Gemini API error:`, error.message);
      
      if (error.message.includes('429') || error.message.includes('quota')) {
        return { 
          parsed: [], 
          raw: `Rate Limit Error: ${error.message}`, 
          error: `Rate Limit: Too many requests. Please wait and try again.`
        };
      }
      
      return { 
        parsed: [], 
        raw: `API Error: ${error.message}`, 
        error: `API Error: ${error.message}`
      };
    }
  });
};
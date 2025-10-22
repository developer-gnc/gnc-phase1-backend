// Simplified calculation service - no calculations, just pass through data as-is
exports.processPageData = (extractedData) => {
  const pageResult = {
    labour: [],
    material: [],
    equipment: [],
    consumables: [],
    subtrade: [],
    labourTimesheet: [],
    equipmentLog: []
  };

  if (Array.isArray(extractedData)) {
    extractedData.forEach(item => {
      const category = item.category?.toLowerCase();
      
      // Just pass through the data without any calculations
      // Data will have CAPITAL field names as returned by Gemini
      if (category === 'labour') {
        pageResult.labour.push(item.data);
      } else if (category === 'material') {
        pageResult.material.push(item.data);
      } else if (category === 'equipment') {
        pageResult.equipment.push(item.data);
      } else if (category === 'consumables') {
        pageResult.consumables.push(item.data);
      } else if (category === 'subtrade') {
        pageResult.subtrade.push(item.data);
      } else if (category === 'labourtimesheet') {
        pageResult.labourTimesheet.push(item.data);
      } else if (category === 'equipmentlog') {
        pageResult.equipmentLog.push(item.data);
      }
    });
  }

  return pageResult;
};
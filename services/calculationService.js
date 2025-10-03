exports.calculateLabourRates = (item) => {
    const unitRate = parseFloat(item.unitRate) || 0;
    const totalHoursManual = parseFloat(item.totalHoursManual) || 0;
    const overtimeHours = parseFloat(item.overtimeHours) || 0;
    const doubleOvertimeHours = parseFloat(item.doubleOvertimeHours) || 0;
  
    const regularAmount = unitRate * totalHoursManual;
    const overtimeAmount = unitRate * 1.5 * overtimeHours;
    const doubleOTAmount = unitRate * 2 * doubleOvertimeHours;
    const subtotal = regularAmount + overtimeAmount + doubleOTAmount;
    const markup = subtotal * 0.15;
    const opBase = subtotal + markup;
    const op = opBase * 0.15;
    const pst = (subtotal + op) * 0.06;
    const gst = (subtotal + op) * 0.05;
    const hst = (subtotal + op) * 0.13;
    const contractorFees = subtotal * 0.0005;
    const totalAmount = subtotal + op + pst + gst + hst + contractorFees;
  
    return {
      ...item,
      regularAmount: regularAmount.toFixed(2),
      overtimeAmount: overtimeAmount.toFixed(2),
      doubleOTAmount: doubleOTAmount.toFixed(2),
      subtotal: subtotal.toFixed(2),
      markup: markup.toFixed(2),
      op: op.toFixed(2),
      pst: pst.toFixed(2),
      gst: gst.toFixed(2),
      hst: hst.toFixed(2),
      contractorFees: contractorFees.toFixed(2),
      totalAmount: totalAmount.toFixed(2)
    };
  };
  
  exports.calculateStandardRates = (item) => {
    const qty = parseFloat(item.qty) || 0;
    const unitRate = parseFloat(item.unitRate) || 0;
  
    const subtotal = qty * unitRate;
    const markup = subtotal * 0.15;
    const opBase = subtotal + markup;
    const op = opBase * 0.15;
    const pst = (subtotal + op) * 0.06;
    const gst = (subtotal + op) * 0.05;
    const hst = (subtotal + op) * 0.13;
    const contractorFees = subtotal * 0.0005;
    const totalAmount = subtotal + op + pst + gst + hst + contractorFees;
  
    return {
      ...item,
      subtotal: subtotal.toFixed(2),
      markup: markup.toFixed(2),
      op: op.toFixed(2),
      pst: pst.toFixed(2),
      gst: gst.toFixed(2),
      hst: hst.toFixed(2),
      contractorFees: contractorFees.toFixed(2),
      totalAmount: totalAmount.toFixed(2)
    };
  };
  
  exports.processPageData = (extractedData) => {
    const pageResult = {
      labour: [],
      material: [],
      equipment: [],
      consumables: [],
      subtrade: []
    };
  
    if (Array.isArray(extractedData)) {
      extractedData.forEach(item => {
        const category = item.category?.toLowerCase();
        
        if (category === 'labour') {
          pageResult.labour.push(exports.calculateLabourRates(item.data));
        } else if (category === 'material') {
          pageResult.material.push(exports.calculateStandardRates(item.data));
        } else if (category === 'equipment') {
          pageResult.equipment.push(exports.calculateStandardRates(item.data));
        } else if (category === 'consumables') {
          pageResult.consumables.push(exports.calculateStandardRates(item.data));
        } else if (category === 'subtrade') {
          pageResult.subtrade.push(exports.calculateStandardRates(item.data));
        }
      });
    }
  
    return pageResult;
  };
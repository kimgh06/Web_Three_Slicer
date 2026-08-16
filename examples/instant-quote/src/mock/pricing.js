// Demo pricing. This is the file you replace — three-slicer produces the estimate, not the price.

export const quoteConfig = {
  currency: 'USD',
  filamentPricePerKg: 25,
  machineHourlyRate: 3,
  handlingFee: 2,
  marginMultiplier: 1.08,
}

export function priceOf(estimate, quantity = 1, config = quoteConfig) {
  const materialCost = estimate.grams * config.filamentPricePerKg / 1000
  const machineCost = (estimate.seconds / 3600) * config.machineHourlyRate
  const subtotal = materialCost + machineCost + config.handlingFee
  const total = subtotal * config.marginMultiplier * quantity
  return {
    materialCost,
    machineCost,
    handlingFee: config.handlingFee,
    margin: subtotal * (config.marginMultiplier - 1) * quantity,
    total,
    currency: config.currency,
  }
}

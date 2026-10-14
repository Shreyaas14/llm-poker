/** Validate a draft before calculating any financial preview. Mirrors the exchange limits. */
export function orderPreview(quantityInput: string, limitPrice: number | null | undefined) {
  const parsedQuantity = Number(quantityInput);
  const quantity = quantityInput.trim() !== "" && Number.isSafeInteger(parsedQuantity) && parsedQuantity >= 1 && parsedQuantity <= 100_000 ? parsedQuantity : null;
  const ticks = limitPrice == null ? NaN : Math.round(limitPrice * 100);
  const price = limitPrice != null && Number.isFinite(limitPrice) && limitPrice >= .01 && limitPrice <= .99 && ticks >= 1 && ticks <= 99 && Math.abs(limitPrice * 100 - ticks) <= 1e-7 ? limitPrice : null;
  return {
    quantity,
    price,
    total: quantity != null && price != null ? quantity * price : null,
    quantityError: quantity == null ? "Enter a whole number of shares from 1 to 100,000." : null,
    priceError: price == null ? "Choose a limit from 1¢ to 99¢ in whole cents." : null,
  };
}

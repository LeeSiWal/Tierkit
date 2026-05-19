export async function confirmTossPayment(input: { paymentKey: string; orderId: string; amount: number }) {
  return { status: "DONE" };
}

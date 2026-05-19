import { NextRequest } from "next/server";
export async function POST(req: NextRequest) {
  const { amount } = await req.json();
  return Response.json({ orderId: "abc", amount });
}

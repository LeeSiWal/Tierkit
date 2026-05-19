import { NextRequest } from "next/server";
import { confirmTossPayment } from "../../../../lib/toss.js";
import { supabase } from "../../../../lib/supabase.js";

// =====================================================================
// Long-form documentation block (intentionally verbose, low signal).
// None of the words in this block should match the user's task terms;
// they exist purely to make the file large enough that skeleton + hot
// spot extraction beats sending the entire file verbatim.
// =====================================================================
// Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do
// eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim
// ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut
// aliquip ex ea commodo consequat. Duis aute irure dolor in
// reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla
// pariatur. Excepteur sint occaecat cupidatat non proident, sunt in
// culpa qui officia deserunt mollit anim id est laborum.
// Curabitur pretium tincidunt lacus. Nulla gravida orci a odio. Nullam
// varius, turpis et commodo pharetra, est eros bibendum elit, nec
// luctus magna felis sollicitudin mauris. Integer in mauris eu nibh
// euismod gravida. Duis ac tellus et risus vulputate vehicula. Donec
// lobortis risus a elit. Etiam tempor. Ut ullamcorper, ligula eu
// tempor congue, eros est euismod turpis, id tincidunt sapien risus a
// quam. Maecenas fermentum consequat mi. Donec fermentum.
// Pellentesque malesuada nulla a mi. Duis sapien sem, aliquet nec,
// commodo eget, consequat quis, neque. Aliquam faucibus, elit ut
// dictum aliquet, felis nisl adipiscing sapien, sed malesuada diam
// lacus eget erat. Cras mollis scelerisque nunc. Nullam arcu. Aliquam
// consequat. Curabitur augue lorem, dapibus quis, laoreet et,
// pretium ac, nisi. Aenean magna nisl, mollis quis, molestie eu,
// feugiat in, orci. In hac habitasse platea dictumst.
// Fusce convallis, mauris imperdiet gravida bibendum, nisl turpis
// suscipit mauris, sed placerat ipsum urna sed risus. In convallis
// tellus a mauris. Curabitur non elit ut libero tristique sodales.
// Mauris a lacus. Donec mattis semper leo. In hac habitasse platea
// dictumst. Vivamus facilisis diam at odio. Mauris dictum, nisi eget
// consequat elementum, lacus nibh interdum nunc, sit amet eleifend
// purus eros nec nisl. Vivamus ut enim non neque accumsan tincidunt.
// Sed dignissim lacinia nunc. Curabitur tortor. Pellentesque nibh.
// Aenean quam. In scelerisque sem at dolor. Maecenas mattis. Sed
// convallis tristique sem. Proin ut ligula vel nunc egestas porttitor.
// Morbi lectus risus, iaculis vel, suscipit quis, luctus non, massa.
// Fusce ac turpis quis ligula lacinia aliquet. Mauris ipsum. Nulla
// metus metus, ullamcorper vel, tincidunt sed, euismod in, nibh.
// Quisque volutpat condimentum velit. Class aptent taciti sociosqu ad
// litora torquent per conubia nostra, per inceptos himenaeos. Nam
// nec ante. Sed lacinia, urna non tincidunt mattis, tortor neque
// adipiscing diam, a cursus ipsum ante quis turpis. Nulla facilisi.
// Ut fringilla. Suspendisse potenti. Nunc feugiat mi a tellus
// consequat imperdiet. Vestibulum sapien. Proin quam. Etiam ultrices.
// Suspendisse in justo eu magna luctus suscipit. Sed lectus. Integer
// euismod lacus luctus magna. Quisque cursus, metus vitae pharetra
// auctor, sem massa mattis sem, at interdum magna augue eget diam.
// Vestibulum ante ipsum primis in faucibus orci luctus et ultrices
// posuere cubilia Curae; Morbi lacinia molestie dui. Praesent blandit
// dolor. Sed non quam. In vel mi sit amet augue congue elementum.
// =====================================================================

export async function POST(req: NextRequest) {
  const { paymentKey, orderId, amount } = await req.json();
  const confirm = await confirmTossPayment({ paymentKey, orderId, amount });
  if (confirm.status !== "DONE") return Response.json({ ok: false });
  await supabase.from("orders").update({ status: "PAID" }).eq("id", orderId);
  return Response.json({ ok: true });
}

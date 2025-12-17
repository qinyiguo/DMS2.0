import { NextResponse } from "next/server";
import { importPartsSalesXlsx } from "@ops/importer";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "缺少檔案 file" }, { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // MVP：先假設你上傳的是「零件銷售」報表；下一步再做 report type detection
  const result = await importPartsSalesXlsx({
    fileName: file.name,
    buffer,
  });

  return NextResponse.json(result);
}

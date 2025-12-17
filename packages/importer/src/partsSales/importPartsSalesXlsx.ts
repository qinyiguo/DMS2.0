import * as XLSX from "xlsx";
import crypto from "crypto";
import { z } from "zod";
import { prisma, ImportStatus } from "@ops/db";

const MappingVersion = "v1";

// 你先把「零件銷售」最關鍵欄位定好（後續欄位新增只要擴充 aliases/optional）
const headerAliases: Record<string, string[]> = {
  branchCode: ["據點", "廠別", "服務廠"],
  checkoutNo: ["結帳單號", "結算單號"],
  itemId: ["項目ID", "項目Id", "項次"],
  workOrderNo: ["工單號", "工作單號", "工作單號碼"],
  partNo: ["零件編號", "料號"],
  partName: ["零件名稱", "品名"],
  qty: ["銷售數量", "數量", "數量(銷售)"],
  saleAmount: ["實際售價", "銷售金額", "售價"],
  costAmount: ["成本總價", "成本金額", "成本"],
  advisorName: ["接待人員", "服務顧問", "顧問"],
  salesName: ["銷售人員", "零件銷售", "銷售"],
};

function normalizeHeader(s: string) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/：/g, ":");
}

function buildHeaderMap(headers: string[]) {
  const map: Record<string, number> = {};
  const normHeaders = headers.map(normalizeHeader);

  for (const [canonical, aliases] of Object.entries(headerAliases)) {
    const idx = normHeaders.findIndex((h) =>
      aliases.map(normalizeHeader).includes(h)
    );
    if (idx >= 0) map[canonical] = idx;
  }

  const unknown = headers.filter((h) => {
    const nh = normalizeHeader(h);
    return !Object.values(headerAliases).flat().map(normalizeHeader).includes(nh);
  });

  return { map, unknown, normHeaders };
}

const CanonicalRowSchema = z.object({
  branchCode: z.string().min(1),
  checkoutNo: z.string().min(1),
  itemId: z.string().min(1),
  partNo: z.string().min(1),
  workOrderNo: z.string().optional(),
  partName: z.string().optional(),
  qty: z.coerce.number().optional(),
  saleAmount: z.coerce.number().optional(),
  costAmount: z.coerce.number().optional(),
  advisorName: z.string().optional(),
  salesName: z.string().optional(),
});

export async function importPartsSalesXlsx(args: {
  fileName?: string;
  buffer: Buffer;
}) {
  const wb = XLSX.read(args.buffer, { type: "buffer" });
  const firstSheetName = wb.SheetNames[0];
  const ws = wb.Sheets[firstSheetName];

  // 取成 2D array：第一列當 header
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as any[][];
  if (rows.length < 2) throw new Error("檔案看起來沒有資料列");

  const headers = rows[0].map((x) => String(x ?? ""));
  const { map, unknown, normHeaders } = buildHeaderMap(headers);

  // 必填欄位檢查（缺就不要進 canonical，但仍可進 staging）
  const requiredKeys: (keyof typeof headerAliases)[] = ["branchCode", "checkoutNo", "itemId", "partNo"];
  const missingRequired = requiredKeys.filter((k) => map[k] === undefined);

  const headerSignature = crypto
    .createHash("sha256")
    .update(JSON.stringify([...normHeaders].sort()))
    .digest("hex");

  const batch = await prisma.importBatch.create({
    data: {
      reportType: "parts_sales",
      mappingVersion: MappingVersion,
      fileName: args.fileName,
      headerSignature,
      headerColumns: headers,
      unknownColumns: unknown,
      status: ImportStatus.STAGED,
    },
  });

  let errorCount = 0;
  let stagedCount = 0;
  let canonicalCount = 0;

  // 逐列處理（MVP 先同步；之後再改批次/queue）
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((v) => String(v ?? "").trim() === "")) continue;

    const rawObj: Record<string, any> = {};
    const unknownObj: Record<string, any> = {};

    // 已知欄位取值
    for (const [canonical, idx] of Object.entries(map)) {
      rawObj[canonical] = String(r[idx] ?? "").trim();
    }

    // 未知欄位完整保留（避免供應商新增欄位你丟掉）
    headers.forEach((h, idx) => {
      if (!unknown.includes(h)) return;
      const v = r[idx];
      if (String(v ?? "").trim() !== "") unknownObj[h] = v;
    });

    // staging 一律存
    await prisma.stagingRow.create({
      data: {
        batchId: batch.id,
        rowIndex: i,
        data: rawObj,
        unknown: Object.keys(unknownObj).length ? unknownObj : undefined,
      },
    });
    stagedCount++;

    // 缺必填欄位就不進 canonical（避免污染 KPI）
    if (missingRequired.length) {
      errorCount++;
      continue;
    }

    const parsed = CanonicalRowSchema.safeParse(rawObj);
    if (!parsed.success) {
      errorCount++;
      continue;
    }

    const d = parsed.data;
    const workOrderKey =
      d.workOrderNo && d.branchCode ? `${d.branchCode}_${d.workOrderNo}` : undefined;

    // upsert：避免重匯入倍增（用 @@unique([branchCode, checkoutNo, itemId])）
    await prisma.partsSalesLine.upsert({
      where: {
        branchCode_checkoutNo_itemId: {
          branchCode: d.branchCode,
          checkoutNo: d.checkoutNo,
          itemId: d.itemId,
        },
      },
      update: {
        workOrderNo: d.workOrderNo,
        workOrderKey,
        partNo: d.partNo,
        partName: d.partName,
        qty: d.qty,
        saleAmount: d.saleAmount,
        costAmount: d.costAmount,
        advisorName: d.advisorName,
        salesName: d.salesName,
      },
      create: {
        batchId: batch.id,
        branchCode: d.branchCode,
        checkoutNo: d.checkoutNo,
        itemId: d.itemId,
        workOrderNo: d.workOrderNo,
        workOrderKey,
        partNo: d.partNo,
        partName: d.partName,
        qty: d.qty,
        saleAmount: d.saleAmount,
        costAmount: d.costAmount,
        advisorName: d.advisorName,
        salesName: d.salesName,
      },
    });

    canonicalCount++;
  }

  await prisma.importBatch.update({
    where: { id: batch.id },
    data: {
      status: errorCount > 0 ? ImportStatus.STAGED : ImportStatus.TRANSFORMED,
      errorCount,
      stagedCount,
      canonicalCount,
    },
  });

  return { batchId: batch.id, stagedCount, canonicalCount, errorCount, missingRequired, unknownColumns: unknown };
}

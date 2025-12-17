"use client";

import { useState } from "react";

export default function Home() {
  const [msg, setMsg] = useState<string>("");

  async function onUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMsg("上傳中...");

    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await res.json();

    if (!res.ok) {
      setMsg(`失敗：${data?.error ?? "unknown"}`);
      return;
    }
    setMsg(`完成：batch=${data.batchId} staged=${data.stagedCount} canonical=${data.canonicalCount} errors=${data.errorCount}`);
  }

  return (
    <main style={{ padding: 24 }}>
      <h1>營運數據平台 MVP</h1>

      <form onSubmit={onUpload}>
        <input name="file" type="file" accept=".xlsx,.xls" required />
        <button type="submit" style={{ marginLeft: 12 }}>上傳</button>
      </form>

      <p style={{ marginTop: 16 }}>{msg}</p>
    </main>
  );
}

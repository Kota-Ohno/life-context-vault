import { describe, it, expect } from "vitest";
import { candidateMemoryStatus, factMemoryStatus, memoryStatusLabel } from "./memoryStatus";

describe("memoryStatus", () => {
  it("treats pending candidates as 確認待ち", () => {
    expect(memoryStatusLabel(candidateMemoryStatus("new"))).toBe("確認待ち");
    expect(memoryStatusLabel(candidateMemoryStatus("needs_user_detail"))).toBe("確認待ち");
  });
  it("treats approved candidates as 承認済み", () => {
    expect(memoryStatusLabel(candidateMemoryStatus("approved"))).toBe("承認済み");
    expect(memoryStatusLabel(candidateMemoryStatus("edited_and_approved"))).toBe("承認済み");
  });
  it("treats blocked candidates as 対象外 (distinct from the 非公開 secret bucket)", () => {
    expect(memoryStatusLabel(candidateMemoryStatus("blocked_sensitive"))).toBe("対象外");
  });
  it("maps rejected and archived candidates to distinct terminal labels", () => {
    expect(memoryStatusLabel(candidateMemoryStatus("rejected"))).toBe("却下");
    expect(memoryStatusLabel(candidateMemoryStatus("archived"))).toBe("削除済み");
  });
  it("treats an active fact as 承認済み and needs_review as 確認待ち", () => {
    expect(memoryStatusLabel(factMemoryStatus("active"))).toBe("承認済み");
    expect(memoryStatusLabel(factMemoryStatus("needs_review"))).toBe("確認待ち");
  });
  it("maps fact lifecycle states to history labels", () => {
    expect(memoryStatusLabel(factMemoryStatus("superseded"))).toBe("置き換え済み");
    expect(memoryStatusLabel(factMemoryStatus("expired"))).toBe("期限切れ");
    expect(memoryStatusLabel(factMemoryStatus("user_hidden"))).toBe("非表示");
    expect(memoryStatusLabel(factMemoryStatus("deleted"))).toBe("削除済み");
  });
});

import { describe, it, expect } from "vitest";
import { sensitivityBucketKey, sensitivityBucketLabel } from "./sensitivityBuckets";

describe("sensitivityBuckets", () => {
  it("maps public and personal to 公開OK", () => {
    expect(sensitivityBucketLabel("public")).toBe("公開OK");
    expect(sensitivityBucketLabel("personal")).toBe("公開OK");
    expect(sensitivityBucketKey("public")).toBe("public_ok");
    expect(sensitivityBucketKey("personal")).toBe("public_ok");
  });
  it("maps private_consequential and sensitive to 要確認", () => {
    expect(sensitivityBucketLabel("private_consequential")).toBe("要確認");
    expect(sensitivityBucketLabel("sensitive")).toBe("要確認");
    expect(sensitivityBucketKey("sensitive")).toBe("needs_review");
  });
  it("maps secret_never_send to 非公開", () => {
    expect(sensitivityBucketLabel("secret_never_send")).toBe("非公開");
    expect(sensitivityBucketKey("secret_never_send")).toBe("private");
  });
});

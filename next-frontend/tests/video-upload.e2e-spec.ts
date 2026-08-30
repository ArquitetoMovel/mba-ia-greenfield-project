import { expect, test } from "./fixtures";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

test.describe("video-upload (Studio workspace)", () => {
  let tmpFilePath: string;

  test.beforeAll(() => {
    tmpFilePath = path.join(os.tmpdir(), "e2e_sample_video.mp4");
    fs.writeFileSync(tmpFilePath, Buffer.alloc(1024 * 100, "a"));
  });

  test.afterAll(() => {
    if (fs.existsSync(tmpFilePath)) {
      fs.unlinkSync(tmpFilePath);
    }
  });

  test("1.1 upload-fluxo-completo-com-sucesso", async ({ page }) => {
    // 1. Authenticate user
    await page.goto("/login");
    await page.getByLabel("Email address").fill("user@example.com");
    await page.getByLabel("Password", { exact: true }).fill("secret123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/$/);

    // 2. Navigate to /studio/upload
    await page.goto("/studio/upload");
    await expect(
      page.getByText("Enviar Vídeo para o StreamTube"),
    ).toBeVisible();

    // 3. Select file via hidden input
    const fileInput = page.getByTestId("video-file-input");
    await fileInput.setInputFiles(tmpFilePath);

    await expect(page.getByText("e2e_sample_video.mp4")).toBeVisible();
    const startBtn = page.getByTestId("start-upload-btn");
    await expect(startBtn).toBeVisible();

    // 4. Start upload
    await startBtn.click();

    // 5. Verify progress indicator
    await expect(page.getByTestId("upload-progress")).toBeVisible();

    // 6. Verify processing completes and ready state is rendered
    await expect(page.getByTestId("upload-ready")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText("Vídeo processado e pronto para reprodução!"),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Assistir ao vídeo" }),
    ).toBeVisible();
  });
});

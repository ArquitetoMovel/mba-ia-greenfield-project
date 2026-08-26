import { expect, test } from "./fixtures"

test.describe("auth-reset-password", () => {
  test("1.1 reset-password-sucesso", async ({ page }) => {
    await page.goto("/reset-password?token=valid-reset-token")

    await expect(page.locator("[data-slot='card']")).toBeVisible()
    await expect(page.getByLabel("New password", { exact: true })).toBeVisible()
    await expect(
      page.getByLabel("Confirm new password", { exact: true })
    ).toBeVisible()

    await page
      .getByLabel("New password", { exact: true })
      .fill("NewPassword1!")
    await page
      .getByLabel("Confirm new password", { exact: true })
      .fill("NewPassword1!")

    const response = page.waitForResponse(
      (res) =>
        res.url().includes("/api/auth/reset-password") &&
        res.request().method() === "POST"
    )
    await page.getByRole("button", { name: "Set new password" }).click()
    await expect((await response).status()).toBe(204)

    await expect(page.getByRole("status")).toContainText("Senha alterada!")
    await expect(page.getByRole("link", { name: "Ir para o login" })).toHaveAttribute(
      "href",
      "/login"
    )
    expect(
      (await page.context().cookies()).some((cookie) =>
        cookie.name.includes("session")
      )
    ).toBe(false)
  })

  test("1.2 reset-password-token-invalido", async ({ page }) => {
    await page.goto("/reset-password?token=invalid-reset-token")
    await page
      .getByLabel("New password", { exact: true })
      .fill("NewPassword1!")
    await page
      .getByLabel("Confirm new password", { exact: true })
      .fill("NewPassword1!")
    await page.getByRole("button", { name: "Set new password" }).click()

    await expect(page.locator("[data-slot='form-error']")).toContainText(
      "Invalid or expired reset token"
    )
    await expect(page.getByRole("status")).toHaveCount(0)
  })

  test("1.3 reset-password-sem-token", async ({ page }) => {
    await page.goto("/reset-password")

    await expect(page.locator("[role='alert']").first()).toContainText(
      "invalid or incomplete"
    )
    await expect(page.locator("[data-slot='reset-password-form']")).toHaveCount(0)
    await expect(
      page.getByRole("link", { name: "Request a new reset link" })
    ).toHaveAttribute("href", "/forgot-password")
  })
})

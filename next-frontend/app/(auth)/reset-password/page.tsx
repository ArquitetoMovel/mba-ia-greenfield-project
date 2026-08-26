import Link from "next/link"

import { AuthFooter } from "@/components/auth/auth-footer"
import { BackLink } from "@/components/auth/back-link"
import { BrandLogo } from "@/components/auth/brand-logo"
import { ResetPasswordForm } from "@/components/auth/reset-password-form"
import { ArrowBackIcon } from "@/components/icons/arrow-back-icon"
import { Card } from "@/components/ui/card"

type ResetPasswordPageProps = {
  searchParams: Promise<{ token?: string | string[] | undefined }>
}

export default async function ResetPasswordPage({
  searchParams,
}: ResetPasswordPageProps) {
  const { token: rawToken } = await searchParams
  const token = typeof rawToken === "string" ? rawToken : ""

  return (
    <main className="flex flex-1 items-center justify-center bg-background px-6 py-10">
      <Card className="relative w-full max-w-[448px] items-center gap-6 px-6 py-10">
        <BackLink
          href="/login"
          aria-label="Back to login"
          className="absolute left-4 top-4 gap-0"
        >
          <ArrowBackIcon className="size-6" />
        </BackLink>

        <BrandLogo size="lg" />

        <h1 className="text-h1 text-foreground text-center">Set new password</h1>
        <p className="text-body-md text-muted-foreground text-center">
          Choose a new password for your StreamTube account.
        </p>

        {token ? (
          <ResetPasswordForm token={token} className="w-full" />
        ) : (
          <div
            role="alert"
            className="flex w-full flex-col items-center gap-2 text-center"
          >
            <p className="text-body-md text-destructive">
              This reset link is invalid or incomplete.
            </p>
            <Link
              href="/forgot-password"
              className="text-link hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded-[var(--radius-0-5)]"
            >
              Request a new reset link
            </Link>
          </div>
        )}

        <AuthFooter
          question="Remember your password?"
          linkLabel="Sign in"
          linkHref="/login"
        />
      </Card>
    </main>
  )
}

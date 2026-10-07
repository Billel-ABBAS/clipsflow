import Image from "next/image";

import { Link } from "@/i18n/navigation";

export function ClipsFlowBrand({
  className = "",
  href = "/",
}: {
  className?: string;
  href?: "/" | "/dashboard";
}) {
  return (
    <Link
      href={href}
      aria-label="ClipsFlow"
      className={`text-foreground focus-visible:ring-ring focus-visible:ring-offset-background inline-flex shrink-0 items-center gap-2.5 rounded-md transition-opacity outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-offset-2 ${className}`}
    >
      <Image
        src="/images/brand/clipsflow-canva-mark.png"
        alt=""
        width={32}
        height={32}
        sizes="32px"
        className="size-8 object-contain"
        priority
      />
      <span className="text-lg font-semibold tracking-tight">ClipsFlow</span>
    </Link>
  );
}

"use client";

import { useStaffT } from "@/lib/staff-i18n";

/**
 * OFFICIAL LETTERHEAD for printed reports (Sales Report and Shift Report):
 * the logo and the full PLC name in English and Amharic. The address and
 * phone are left BLANK on purpose: the person who prepares the paper writes
 * their own name, phone and address by hand.
 */
export default function PrintLetterhead({ logoUrl }: { logoUrl?: string | null }) {
  const { t } = useStaffT();
  return (
    <>
      <div style={{ textAlign: "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoUrl || "/logo.png"} alt="Fana Cafe and Restaurant logo" style={{ height: 60, margin: "0 auto 6px" }} />
        <h1 style={{ fontSize: "22px", fontWeight: 900 }}>Fana Cafe and Restaurant PLC</h1>
        <p style={{ fontSize: "15px", fontWeight: 700 }}>ፋና ካፌ እና ሬስቶራንት ኃ.የተ.የ.ግ.ማ.</p>
      </div>
      <div style={{ fontSize: "12px", marginTop: 8, lineHeight: 2.2 }}>
        <p>{t("Prepared by (name):")} ................................................................</p>
        <p>
          {t("Phone:")} .................................... {t("Address:")} ........................................................
        </p>
      </div>
    </>
  );
}

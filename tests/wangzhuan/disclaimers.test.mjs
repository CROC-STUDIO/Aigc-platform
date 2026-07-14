import assert from "node:assert/strict";
import test from "node:test";

import {
  DISCLAIMER_PRESETS,
  resolveDisclaimerPreset,
  resolveDisclaimerText
} from "../../server/wangzhuan/disclaimers.mjs";

const ARABIC_DISCLAIMER = "تخضع المكافآت لقواعد التطبيق، والأهلية، وإكمال المهام، والتوافر حسب المنطقة. النتائج غير مضمونة.";
const COMMON_LANGUAGE_DISCLAIMERS = Object.freeze({
  es: {
    locale: "es-MX",
    text: "Las recompensas están sujetas a las reglas de la aplicación, los requisitos de elegibilidad, la finalización de las tareas y la disponibilidad regional. Los resultados no están garantizados."
  },
  fr: {
    locale: "fr-FR",
    text: "Les récompenses dépendent des règles de l’application, des conditions d’éligibilité, de l’accomplissement des tâches et de la disponibilité dans la région concernée. Les résultats ne sont pas garantis."
  },
  de: {
    locale: "de-DE",
    text: "Prämien hängen von den Regeln der App, der Teilnahmeberechtigung, dem Abschluss von Aufgaben und der regionalen Verfügbarkeit ab. Ergebnisse werden nicht garantiert."
  },
  id: {
    locale: "id-ID",
    text: "Hadiah bergantung pada aturan aplikasi, kelayakan pengguna, penyelesaian tugas, dan ketersediaan regional. Hasil tidak dijamin."
  },
  th: {
    locale: "th-TH",
    text: "รางวัลขึ้นอยู่กับกฎของแอป การมีสิทธิ์ได้รับรางวัล การทำภารกิจให้สำเร็จ และความพร้อมให้บริการในแต่ละภูมิภาค ไม่รับประกันผลลัพธ์"
  },
  vi: {
    locale: "vi-VN",
    text: "Phần thưởng phụ thuộc vào quy định của ứng dụng, điều kiện nhận thưởng, việc hoàn thành nhiệm vụ và tình trạng khả dụng tại từng khu vực. Kết quả không được đảm bảo."
  }
});

test("Arabic disclaimer preset uses the approved MSA translation", () => {
  assert.equal(DISCLAIMER_PRESETS.ar, ARABIC_DISCLAIMER);
  assert.equal(resolveDisclaimerText("ar-SA", "auto"), ARABIC_DISCLAIMER);
});

test("Arabic locale variants automatically select the Arabic preset", () => {
  for (const locale of ["ar", "ar-SA", "ar-AE"]) {
    assert.equal(resolveDisclaimerPreset(locale, "auto"), "ar");
  }
});

test("system common locales resolve to localized disclaimer presets", () => {
  for (const [preset, { locale, text }] of Object.entries(COMMON_LANGUAGE_DISCLAIMERS)) {
    assert.equal(DISCLAIMER_PRESETS[preset], text);
    assert.equal(resolveDisclaimerPreset(locale, "auto"), preset);
    assert.equal(resolveDisclaimerText(locale, "auto"), text);
  }
});

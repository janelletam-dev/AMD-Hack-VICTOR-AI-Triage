"""E.L.M.E.R. — Evidence Synthesiser.

End-of-triage comprehensive report. Triggered on demand by the clinician
(POST /api/report), not on the hot path.

Latency budget: <5s.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from services.vllm_service import ChatMessage, LLMUnavailable, VLLMService

log = logging.getLogger("victor.agent.elmer")

PROMPTS_DIR = Path(__file__).parent.parent / "prompts"
PROMPT = (PROMPTS_DIR / "elmer_system.txt").read_text()
REFERENCES = json.loads((PROMPTS_DIR / "references.json").read_text())


class ElmerAgent:
    name = "E.L.M.E.R."

    def __init__(self, llm: VLLMService) -> None:
        self.llm = llm

    async def synthesize(self, session_log: dict) -> dict:
        """Generate the full evidence report for a completed triage session.

        `session_log` should contain:
          transcript_lines: list[ {text, language, is_final} ]
          biomarker_summary: dict
          flags:        list[ concordance flag dicts ]
          soap:         dict (final SOAP from S.C.R.I.B.E.)
          esi:          { standard, adjusted, reason }
          identity:     { name, dob, complaint }
        """
        try:
            # Inject references inline so the model has the bibliographic
            # strings right next to the citation guidance from its prompt.
            user = (
                "Generate the evidence report. Markdown only. Cite from the "
                "references below using the inline short-cite format; full "
                "bibliographic entries belong in the `## References` section.\n\n"
                "AVAILABLE REFERENCES:\n"
                f"{json.dumps(REFERENCES, indent=2)}\n\n"
                "SESSION LOG:\n"
                f"{json.dumps(session_log, default=str, indent=2)}"
            )
            report = await self.llm.chat(
                [
                    ChatMessage(role="system", content=PROMPT),
                    ChatMessage(role="user", content=user),
                ],
                temperature=0.3,
                max_tokens=2000,
            )
            return self._wrap_response(session_log, report)
        except LLMUnavailable as e:
            log.info("elmer fallback (LLM unavailable): %s", e)
            return self._wrap_response(
                session_log,
                self._fallback_report(session_log),
            )

    @staticmethod
    def _wrap_response(session_log: dict, report_md: str) -> dict:
        """Match the ReportResponse shape in routers/reports.py."""
        esi = session_log.get("esi") or {}
        return {
            "report": report_md,
            "esi_standard": int(esi.get("standard") or 0),
            "esi_adjusted": int(esi.get("adjusted") or 0),
            "flags": session_log.get("flags") or [],
            "biomarker_summary": session_log.get("biomarker_summary") or {},
            "soap_note": session_log.get("soap") or {},
            "agent": "E.L.M.E.R.",
        }

    @staticmethod
    def _fallback_report(session_log: dict) -> str:
        identity = session_log.get("identity") or {}
        soap = session_log.get("soap") or {}
        flags = session_log.get("flags") or []
        esi = session_log.get("esi") or {}

        flag_lines = []
        for f in flags:
            tier = f.get("tier")
            phrase = f.get("trigger_phrase")
            gloss = f.get("gloss") or f.get("gloss_seed") or ""
            flag_lines.append(f"- Tier {tier} · trigger {phrase!r} — {gloss}")

        return (
            "# Triage Encounter Report\n\n"
            f"## Presenting Complaint\n{identity.get('complaint') or '—'}\n\n"
            "## Triage Decision\n"
            f"| | Score | Reasoning |\n|---|---|---|\n"
            f"| Standard ESI | {esi.get('standard', '—')} | text-based triage |\n"
            f"| V.I.C.T.O.R.-adjusted ESI | {esi.get('adjusted', '—')} | "
            f"{esi.get('reason', '—')} |\n\n"
            "## Concordance Flags\n"
            + ("\n".join(flag_lines) or "_None._")
            + "\n\n## SOAP Note\n"
            f"**S:** {soap.get('subjective', '—')}\n\n"
            f"**O:** {soap.get('objective', '—')}\n\n"
            f"**A:** {soap.get('assessment', '—')}\n\n"
            f"**P:** {soap.get('plan', '—')}\n\n"
            "## Limitations\n"
            "- LLM endpoint was unavailable; report generated from session log only.\n"
            "- Scientific Basis citations omitted in fallback mode.\n"
            "- This report augments, does not replace, clinical judgment.\n"
        )

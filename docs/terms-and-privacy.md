# Terms of Use & Privacy

**Last updated:** March 2026

"We" in this document refers to the maintainers of the open-source Page Agent project (https://github.com/alibaba/page-agent). "The software" refers to the Page Agent JavaScript library. This document covers the software itself and the testing API we provide — **not** any third-party product or service built with it.

---

## 1. Open Source Software Privacy

The software is a **client-side only** tool with a "Bring Your Own Key" (BYOK) architecture. The software itself does **not** include any backend service. The software does **not** collect or transmit any user data on its own, and we do **not** have access to your browsing activity, page content, or task instructions through the software.

All data transmission occurs **only** between your browser and the LLM provider you configure. You are in full control of which provider receives your data.

The project is open source under the [MIT License](https://github.com/alibaba/page-agent/blob/main/LICENSE) and can be audited at: https://github.com/alibaba/page-agent

---

## 2. Testing API and Demo Disclaimer & Terms of Use

To facilitate easy testing and technical evaluation, we provide a free testing LLM API. This API is used in the project homepage's live demo and the pre-built demo CDN bundles. Users may also use it independently for their own technical evaluation of the software.

This free testing API is provided **strictly for technical evaluation and R&D purposes only**. It must not be used in any production environment. By using this API, you agree to the following terms:

-   **Permitted Use Only**: This API must be used solely for technical evaluation of the software. Any other use — including integration into other products or services, unlawful activities, violation of the underlying LLM provider's usage policies, or automated scraping at scale — is strictly prohibited.

-   **No Sensitive Data**: You are strictly prohibited from inputting any Personal Identifiable Information (PII), confidential business data, financial/medical records, or using this agent on web pages containing such sensitive information.

-   **Data Processing**: We do not store or log your prompts, webpage data (HTML), or any submitted content, nor do we use such data for model training. All data is processed in-transit and immediately discarded. We perform in-memory request validation to prevent abuse of the testing API, and temporarily process IP addresses for rate-limiting purposes. No data from these processes is retained. Data is processed through Alibaba Cloud infrastructure, which is subject to its own privacy policy.

-   **Independent Infrastructure**: The software is completely frontend-based with a "Bring Your Own Key" (BYOK) architecture and **no built-in backend**. To facilitate easy testing, the maintainers have purchased public cloud services from Alibaba Cloud China ([aliyun.com](https://www.aliyun.com) Function Compute and BaiLian Qwen models). This project is not a product of, nor endorsed by, Alibaba Cloud.

-   **No Guaranteed Availability**: This testing API may be rate-limited, degraded, or discontinued at any time without prior notice.

-   **"AS IS" & Limitation of Liability**: This service is provided strictly on an "AS IS" and "AS AVAILABLE" basis, without any warranties. The maintainers bear no liability for any data loss, service interruption, or legal consequences arising from your use of this service.

-   **Recommendation for Real Usage**: For secure and continuous usage, we strongly advise using the BYOK mode with your own legally compliant commercial LLM API keys, or connecting to local, offline models (e.g., Ollama).

**Note**: This free testing LLM API processes data via servers located in Mainland China. If you are located in a region with strict data localization laws (such as the EU/EEA), please do not use this API.

**Age Requirement**: The software and testing API are not intended for use by individuals under the age of 13 (or the minimum age of digital consent in your jurisdiction).

---

## Changes

We may update these terms at our discretion.

## Contact

https://github.com/alibaba/page-agent/issues

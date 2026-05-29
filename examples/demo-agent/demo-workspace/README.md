# Demo Workspace

This workspace is copied into `/workspace` in the Foundry Hosted Agent container.

It provides stable, local source material for demo prompts. The goal is to avoid live web research during demos and make the generated Hyperframes HTML + Edge TTS narration reproducible.

Suggested demo prompt:

```text
你是技术战略助理。请基于 /workspace/sources 中的资料，分析 Claude Code、OpenAI Codex、OpenCode 三个 coding agent 的优势、短板、适用场景和风险，生成一个带中文旁白的 Hyperframes HTML 汇报页面，不要生成视频。

要求：
1. 输出到 /files/coding-agent-comparison/
2. 生成 index.html，采用 clean corporate 风格，16:9，适合技术管理层观看。
3. 生成 7-8 个 section：标题、定位、三者优势短板、评分矩阵、选型建议、结论。
4. 使用 Edge TTS 生成中文旁白 narration.mp3，声音使用 zh-CN-XiaoxiaoNeural。
5. HTML 中嵌入 narration.mp3，并提供播放控件。
6. 生成 script.md，包含完整旁白稿。
7. 最后总结生成了哪些文件，以及如何预览。
```

Source files are in `sources/`.

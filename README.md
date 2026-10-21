# 随看随学

一个 Chrome 浏览器插件：边看英文网页和视频边积累单词。下载安装就能用，词典和词频表都内置在插件里，不需要账号、不需要联网查词，也不依赖任何 AI 服务。

## 功能

- **词汇量测试**：第一次安装会自动打开。自适应出题（根据前面的回答选下一题的难度），五选一，干扰项与答案同词性、难度相近，25～45 题后给出词汇量和估计区间，并据此决定哪些词算你的生词。
- **生词高亮**（阅读）：在英文网页上把超出你水平的词标黄，鼠标停在上面显示音标和中文释义，可以「加入单词本」或「我认识」（以后不再标）。
- **划词加入单词本**（阅读）：选中网页上的单词或短语，点「查词」，再点「加入单词本」。会同时记下所在的句子和网址。
- **视频高频词总结**：在有英文字幕的视频页面打开插件面板，点「总结这段视频的高频词」，列出生词和常用短语，勾选后一键加入单词本。
  - 支持带字幕轨的 HTML5 视频，以及 YouTube、B 站（需要在播放器里打开字幕）。
  - 没有字幕的视频：在面板里点「没有字幕？开始本地听写」，然后正常播放。插件会录下这个标签页的声音，用内置的 Whisper tiny.en 模型在你电脑上转成文字，不联网。点「停止听写」结束。目前只识别英语。
- **单词本**：按来源筛选、搜索、删除、导出 CSV（可导入 Excel 或 Anki）。

单词本只保存在你自己的浏览器里（`chrome.storage.local`）。

## 安装（开发者模式）

1. 打开 Chrome，地址栏输入 `chrome://extensions`。
2. 打开右上角的「开发者模式」。
3. 点「加载已解压的扩展程序」，选择这个文件夹（包含 `manifest.json` 的那一层）。
4. 会自动打开词汇量测试页，测完点「保存」。已经打开的网页需要刷新一次才会生效。

Edge 浏览器同样适用（`edge://extensions`）。

## 目录

```
manifest.json        插件配置
background.js        后台：加载离线词典，查词，统计视频字幕高频词
content/             注入网页的脚本：高亮、释义卡片、划词、收集字幕
popup/               点击插件图标弹出的面板
pages/               词汇量测试页（vocab-model.js 是估算模型）、单词本页
lib/                 共用的分词和存储代码
data/                离线词典数据（由 tools/build_data.py 生成）
asr/                 本地语音识别：录标签页声音（offscreen 页面）+ Whisper 转文字（worker）
models/              Whisper tiny.en 量化模型（约 43MB）
vendor/transformers/ Transformers.js 3.8.1 和 ONNX Runtime 的 wasm 运行库
tools/build_data.py  从 ECDICT 重新生成 data/ 的脚本
```

## 重新生成词典数据

```bash
curl -L -o ecdict.csv https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv
python3 tools/build_data.py ecdict.csv
```

## 数据来源

- 英汉释义、音标、词频排名来自 [ECDICT](https://github.com/skywind3000/ECDICT)（MIT 许可）。
- 语音识别模型 [Xenova/whisper-tiny.en](https://huggingface.co/Xenova/whisper-tiny.en)，源自 OpenAI Whisper（MIT 许可）。
- 运行库 [Transformers.js](https://github.com/huggingface/transformers.js)（Apache-2.0，许可证见 vendor/transformers/LICENSE）。

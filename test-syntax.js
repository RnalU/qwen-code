// 简单的语法测试脚本
const fs = require('fs');
const path = require('path');

console.log('=== ZHIPU AI 语法检查 ===\n');

const zhipuFilePath = path.join(
  __dirname,
  'packages/core/src/core/zhipuContentGenerator.ts',
);

try {
  const content = fs.readFileSync(zhipuFilePath, 'utf8');

  // 基本语法检查
  const lines = content.split('\n');
  let braceCount = 0;
  let parenCount = 0;
  let bracketCount = 0;
  let hasSyntaxErrors = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // 检查括号平衡
    for (const char of line) {
      switch (char) {
        case '{':
          braceCount++;
          break;
        case '}':
          braceCount--;
          break;
        case '(':
          parenCount++;
          break;
        case ')':
          parenCount--;
          break;
        case '[':
          bracketCount++;
          break;
        case ']':
          bracketCount--;
          break;
      }
    }

    // 检查常见语法错误
    if (line.includes('async embedContent(') && line.includes('): Promise<')) {
      // 检查方法定义是否正确
      if (!line.includes('request: EmbedContentParameters')) {
        console.log(`❌ 第${lineNumber}行: embedContent方法参数定义错误`);
        hasSyntaxErrors = true;
      }
    }

    if (
      line.includes('private convertToZhipuFormat') &&
      line.includes('): ZhipuMessage[]')
    ) {
      // 检查重复的方法定义
      const methodCount = (content.match(/private convertToZhipuFormat/g) || [])
        .length;
      if (methodCount > 1) {
        console.log(
          `❌ 发现${methodCount}个convertToZhipuFormat方法定义，应该只有1个`,
        );
        hasSyntaxErrors = true;
      }
    }
  }

  // 检查括号平衡
  if (braceCount !== 0) {
    console.log(
      `❌ 大括号不平衡: ${braceCount > 0 ? '缺少' : '多余'}${Math.abs(braceCount)}个}`,
    );
    hasSyntaxErrors = true;
  }

  if (parenCount !== 0) {
    console.log(
      `❌ 圆括号不平衡: ${parenCount > 0 ? '缺少' : '多余'}${Math.abs(parenCount)}个}`,
    );
    hasSyntaxErrors = true;
  }

  if (bracketCount !== 0) {
    console.log(
      `❌ 方括号不平衡: ${bracketCount > 0 ? '缺少' : '多余'}${Math.abs(bracketCount)}个}`,
    );
    hasSyntaxErrors = true;
  }

  if (!hasSyntaxErrors) {
    console.log('✅ 基本语法检查通过');
    console.log(`✅ 文件总行数: ${lines.length}`);
    console.log(`✅ 括号平衡检查通过`);
  } else {
    console.log('❌ 发现语法错误，请检查代码');
  }

  console.log('\n=== 检查完成 ===');
} catch (error) {
  console.error('❌ 读取文件失败:', error.message);
}

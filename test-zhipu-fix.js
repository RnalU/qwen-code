// 简单的测试文件来验证ZHIPU AI修复
const fs = require('fs');
const path = require('path');

// 读取修复后的文件
const zhipuFilePath = path.join(
  __dirname,
  'packages/core/src/core/zhipuContentGenerator.ts',
);
const content = fs.readFileSync(zhipuFilePath, 'utf8');

console.log('=== ZHIPU AI 工具调用修复验证 ===\n');

// 检查关键修复点
const checks = [
  {
    name: '删除了Object.assign functionCalls',
    check:
      !content.includes('Object.assign(generateContentResponse, {') &&
      !content.includes('functionCalls:'),
  },
  {
    name: '新增了convertZhipuResponseToParts方法',
    check: content.includes('convertZhipuResponseToParts'),
  },
  {
    name: '修复了工具调用处理逻辑',
    check:
      content.includes(
        'convertZhipuResponseToParts(delta?.content, zhipuResponse.tool_calls)',
      ) &&
      content.includes(
        'convertZhipuResponseToParts(choice.message?.content, zhipuResponse.tool_calls)',
      ),
  },
  {
    name: '改进了工具声明提取',
    check: content.includes(
      'console.log(`ZHIPU: Adding tool: ${toolFunction.name}`);',
    ),
  },
  {
    name: '添加了调试信息',
    check:
      content.includes('ZHIPU: Received') &&
      content.includes('tool calls from API'),
  },
  {
    name: '添加了错误处理',
    check: content.includes('Error parsing tool call arguments'),
  },
];

console.log('修复检查结果:');
checks.forEach((check, index) => {
  const status = check.check ? '✅ 通过' : '❌ 失败';
  console.log(`${index + 1}. ${check.name}: ${status}`);
});

const passedChecks = checks.filter((check) => check.check).length;
const totalChecks = checks.length;

console.log(`\n总结: ${passedChecks}/${totalChecks} 项检查通过`);

if (passedChecks === totalChecks) {
  console.log('🎉 所有修复都已成功应用！');
  console.log('\n主要修复内容:');
  console.log('1. 移除了错误的Object.assign functionCalls方式');
  console.log('2. 新增了convertZhipuResponseToParts方法正确处理工具调用');
  console.log('3. 修复了普通和流式响应的工具调用处理');
  console.log('4. 改进了工具声明格式和错误处理');
  console.log('5. 添加了详细的调试信息');
  console.log('6. 增强了错误处理机制');
} else {
  console.log('⚠️  部分修复可能未完全应用，请检查代码');
}

console.log('\n=== 修复完成 ===');

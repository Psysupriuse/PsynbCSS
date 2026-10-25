// 删除活动前二次确认
document.querySelectorAll('form.js-confirm').forEach((form) => {
  form.addEventListener('submit', (e) => {
    if (!window.confirm('确定要删除该活动吗？删除后学生端将不可见。')) e.preventDefault();
  });
});

// V3.0：提交期间禁用按钮，防止连点造成重复报名/重复加入候补
document.querySelectorAll('form.js-submitting').forEach((form) => {
  form.addEventListener('submit', () => {
    const btn = form.querySelector('button[type="submit"]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.dataset.label = btn.textContent;
    btn.textContent = '提交中…';
  });
});

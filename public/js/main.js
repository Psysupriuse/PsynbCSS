// 删除活动前二次确认
document.querySelectorAll('form.js-confirm').forEach((form) => {
  form.addEventListener('submit', (e) => {
    if (!window.confirm('确定要删除该活动吗？删除后学生端将不可见。')) e.preventDefault();
  });
});

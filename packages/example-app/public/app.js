const backdrop = document.getElementById('modal-backdrop');
const form = document.getElementById('event-form');
const toast = document.getElementById('toast');

document.getElementById('new-event').addEventListener('click', () => {
  backdrop.classList.add('open');
  document.getElementById('event-name').value = '';
  document.getElementById('event-type').value = '';
});

document.getElementById('cancel-event').addEventListener('click', () => {
  backdrop.classList.remove('open');
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('event-name').value.trim();
  const type = document.getElementById('event-type').value || 'Meetup';
  const button = document.getElementById('create-event');
  button.disabled = true;
  button.textContent = 'Creating…';
  // Simulated slow save — the tutorial's waitFor hook waits this out.
  setTimeout(() => {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${name}</td><td>${type}</td><td>Draft</td>`;
    document.getElementById('event-rows').appendChild(row);
    backdrop.classList.remove('open');
    button.disabled = false;
    button.textContent = 'Create event';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }, 1500);
});

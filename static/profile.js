const state = {
  skills: new Set(window.PROFILE_STATE?.skills || []),
  target_roles: new Set(window.PROFILE_STATE?.target_roles || []),
};

function setMessage(text, type = '') {
  const message = document.getElementById('profileMessage');
  message.textContent = text;
  message.className = type;
}

function validateAssetFile(file, allowedTypes, label) {
  if (!file) return true;
  if (file.size > 1024 * 1024) {
    setMessage(`${label} must be 1 MB or smaller.`, 'error');
    return false;
  }
  if (!allowedTypes.includes(file.type)) {
    setMessage(`${label} must be ${label === 'Profile photo' ? 'a JPEG image' : 'a PDF file'}.`, 'error');
    return false;
  }
  return true;
}

function syncCard(button, field) {
  const value = button.dataset.value;
  button.classList.toggle('selected', state[field].has(value));
}

function addCard(field, value) {
  const cleanValue = String(value || '').trim();
  if (!cleanValue) return;

  state[field].add(cleanValue);
  const container = document.querySelector(`.card-options[data-field="${field}"]`);
  let button = [...container.querySelectorAll('.select-card')]
    .find(card => card.dataset.value.toLowerCase() === cleanValue.toLowerCase());

  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'select-card';
    button.dataset.value = cleanValue;
    button.textContent = cleanValue;
    button.addEventListener('click', () => toggleCard(button, field));
    container.appendChild(button);
  }

  syncCard(button, field);
}

function toggleCard(button, field) {
  const value = button.dataset.value;
  if (state[field].has(value)) {
    state[field].delete(value);
  } else {
    state[field].add(value);
  }
  syncCard(button, field);
}

document.querySelectorAll('.card-options').forEach(container => {
  const field = container.dataset.field;
  container.querySelectorAll('.select-card').forEach(button => {
    button.addEventListener('click', () => toggleCard(button, field));
    syncCard(button, field);
  });
});

document.querySelectorAll('[data-add-other]').forEach(button => {
  button.addEventListener('click', () => {
    const field = button.dataset.addOther;
    const input = document.getElementById(field === 'skills' ? 'skillOther' : 'roleOther');
    addCard(field, input.value);
    input.value = '';
    input.focus();
  });
});

document.querySelectorAll('.other-row input').forEach(input => {
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    input.parentElement.querySelector('button').click();
  });
});

document.getElementById('profilePhotoInput')?.addEventListener('change', event => {
  const file = event.target.files[0];
  if (!file) return;
  if (!validateAssetFile(file, ['image/jpeg'], 'Profile photo')) {
    event.target.value = '';
    return;
  }
  const previewUrl = URL.createObjectURL(file);
  const summary = document.querySelector('.profile-summary');
  const existing = document.getElementById('summaryPhoto') || document.getElementById('summaryInitial');
  const img = document.createElement('img');
  img.id = 'summaryPhoto';
  img.src = previewUrl;
  img.alt = 'Profile photo preview';
  existing.replaceWith(img);
  summary.querySelector('strong').textContent = summary.querySelector('strong').textContent || 'Your profile';
});

document.getElementById('resumeInput')?.addEventListener('change', event => {
  const file = event.target.files[0];
  if (!validateAssetFile(file, ['application/pdf'], 'Resume')) {
    event.target.value = '';
    return;
  }
  if (file) {
    document.getElementById('resumeLabel').textContent = file.name;
  }
});

document.getElementById('profileForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('saveProfileBtn');
  const formData = new FormData(event.currentTarget);
  const profilePhoto = document.getElementById('profilePhotoInput')?.files[0];
  const resume = document.getElementById('resumeInput')?.files[0];
  if (!validateAssetFile(profilePhoto, ['image/jpeg'], 'Profile photo')) return;
  if (!validateAssetFile(resume, ['application/pdf'], 'Resume')) return;

  formData.set('skills', JSON.stringify([...state.skills]));
  formData.set('target_roles', JSON.stringify([...state.target_roles]));

  button.disabled = true;
  button.textContent = 'Saving...';
  setMessage('Saving your profile...');

  try {
    const response = await fetch('/api/profile', {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Profile save failed.');

    state.skills = new Set(data.skills || []);
    state.target_roles = new Set(data.target_roles || []);
    setMessage('Profile saved successfully.', 'success');
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Save Profile';
  }
});

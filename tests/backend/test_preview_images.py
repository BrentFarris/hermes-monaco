import base64
import hashlib
import os

import pytest

from backend.errors import WorkspaceError
from backend.files import MAX_IMAGE_BYTES

BASE = '/api/plugins/hermes-monaco'


@pytest.mark.parametrize('name,raw,mime', [
    ('λ.PNG', b'\x89PNG\r\n\x1a\n' + b'png', 'image/png'),
    ('image.jpg', b'\xff\xd8\xff' + b'jpeg', 'image/jpeg'),
    ('image.JPEG', b'\xff\xd8\xff' + b'jpeg', 'image/jpeg'),
    ('image.gif', b'GIF89a' + b'gif', 'image/gif'),
    ('image.webp', b'RIFF\x10\x00\x00\x00WEBP', 'image/webp'),
    ('image.svg', b'\xef\xbb\xbf<?xml version="1.0"?><!-- icon --><svg xmlns="http://www.w3.org/2000/svg"></svg>', 'image/svg+xml'),
])
def test_image_bytes_mime_revision_and_json_bridge(client, workspace, name, raw, mime):
    (workspace.root / name).write_bytes(raw)
    handle = client.post(BASE + '/workspace', json={'cwd': str(workspace.root)}).json()['id']
    result = client.get(BASE + '/preview-image', params={'workspaceId': handle, 'path': name}).json()
    assert result == {'mimeType': mime, 'revision': hashlib.sha256(raw).hexdigest(), 'dataBase64': base64.b64encode(raw).decode('ascii')}


@pytest.mark.parametrize('path', ['../outside.png', '/image.png', 'C:\\image.png', 'image.png:stream'])
def test_image_path_confinement(workspace, path):
    with pytest.raises(WorkspaceError):
        workspace.preview_image(path)


def test_image_limits_formats_and_missing_file(client, workspace):
    for name, data in [('large.png', b'\x89PNG\r\n\x1a\n' + b'x' * MAX_IMAGE_BYTES), ('fake.png', b'<html>not an image</html>'), ('file.bmp', b'BM')]:
        (workspace.root / name).write_bytes(data)
    for name, code in [('large.png', 'too_large'), ('fake.png', 'unsupported_image'), ('file.bmp', 'unsupported_image')]:
        with pytest.raises(WorkspaceError) as error:
            workspace.preview_image(name)
        assert error.value.code == code
    (workspace.root / 'directory.png').mkdir()
    with pytest.raises(WorkspaceError) as error:
        workspace.preview_image('directory.png')
    assert error.value.code == 'not_file'
    handle = client.post(BASE + '/workspace', json={'cwd': str(workspace.root)}).json()['id']
    assert client.get(BASE + '/preview-image', params={'workspaceId': handle, 'path': 'missing.png'}).json()['error']['code'] == 'not_found'


def test_image_symlink_escape_and_internal_link(workspace, tmp_path):
    outside = tmp_path / 'outside.svg'
    outside.write_text('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    local = workspace.root / 'local.svg'
    local.write_bytes(outside.read_bytes())
    try:
        (workspace.root / 'escape.svg').symlink_to(outside)
        (workspace.root / 'inside.svg').symlink_to(local)
    except OSError:
        pytest.skip('This Windows account cannot create symlinks')
    with pytest.raises(WorkspaceError) as error:
        workspace.preview_image('escape.svg')
    assert error.value.code == 'outside_workspace'
    assert workspace.preview_image('inside.svg') == workspace.preview_image('local.svg')


@pytest.mark.skipif(not hasattr(os, 'mkfifo'), reason='Named filesystem pipes are POSIX-only')
def test_image_rejects_special_files_without_opening_them(workspace):
    os.mkfifo(workspace.root / 'pipe.png')
    with pytest.raises(WorkspaceError) as error:
        workspace.preview_image('pipe.png')
    assert error.value.code == 'not_file'

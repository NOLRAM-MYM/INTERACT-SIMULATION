# Interact Simulation

Dashboard científico com cinco módulos de simulação interativa — mecânica dos
fluidos, resistência dos materiais, química, física e tribologia. Cada módulo
resolve as equações no servidor (Django + DRF) e desenha o resultado no
navegador com Plotly (gráficos) e Three.js (viewport 3D), recalculando ao vivo
conforme os parâmetros mudam.

Autor: **Marlon Yoshihiro Murakami** · Licença: [MIT](LICENSE)

---

## Módulos

| Módulo | Rota | O que resolve |
|---|---|---|
| **Fluidos** | `/api/fluids/` | Escoamento em tubo: Reynolds, fator de atrito (Churchill 1977, verificado contra Colebrook em alta precisão), perda de carga Darcy-Weisbach, perfil radial de velocidade |
| **Materiais** | `/api/materials/` | Deflexão de vigas Euler-Bernoulli — quatro casos de carga (pontual/uniforme, biapoiada/engastada) em forma fechada |
| **Química** | `/api/chemistry/` | Tabela periódica dos 118 elementos, átomo de Bohr 3D, simulador de ligações e estequiometria |
| **Física** | `/api/physics/` | Lançamento de projéteis com arrasto quadrático (Runge-Kutta 4) e eletromagnetismo: força de Lorentz, polos magnéticos e transiente de motor CC |
| **Tribologia** | `/api/tribology/` | Geometria de engrenagens retas (AGMA/ISO) e lubrificação elastohidrodinâmica de Dowson-Higginson |

> As páginas HTML ficam sob o prefixo `/api/` por herança do roteamento atual
> (`config/urls.py` monta cada app em `api/<módulo>/`, e cada `urls.py` serve a
> página no caminho vazio). É uma esquisitice de URL, não um defeito.

---

## Requisitos

- **Python 3.12+** (testado em 3.14)
- **Node.js 18+**
- Redis — apenas em produção, para o cache que sustenta o rate limit da API

---

## Como rodar em desenvolvimento

```bash
# 1. Dependências Python
python -m venv .venv
.venv/Scripts/activate          # Linux/macOS: source .venv/bin/activate
pip install -r requirements-dev.txt

# 2. Dependências e bundles do frontend
npm install
npm run build

# 3. Banco e servidor
python manage.py migrate
python manage.py runserver
```

Abra <http://127.0.0.1:8000/>.

O `npm run build` é obrigatório antes do primeiro `runserver`: os templates
resolvem os bundles pelo manifesto do Vite
(`apps/core/templatetags/vite.py`), e sem ele não há manifesto.

### Hot reload

Para editar o frontend sem rebuildar a cada mudança, defina
`VITE_DEV_SERVER_URL=http://localhost:5173` no `.env` e rode `npm run dev` em
paralelo ao `runserver`. Com a variável vazia, os templates voltam a ler o
manifesto compilado.

### Dependências opcionais

`requirements-advanced.txt` traz `mendeleev`, `pymatgen`, `ase` e `sfepy`.
Nenhuma é necessária: o módulo de química usa um `periodic_table.json` local
como fallback quando o `mendeleev` não está instalado. Elas não têm wheels
para Python 3.14 no Windows.

---

## Deploy

**A ordem importa:**

```bash
npm run build && python manage.py collectstatic --noinput
```

O Vite nomeia cada bundle com um hash de conteúdo, e o
`CompressedManifestStaticFilesStorage` do WhiteNoise resolve esses nomes pelo
manifesto gerado no `collectstatic`. Se o build rodar **depois**, o manifesto
fica desatualizado e toda página responde 500 — `vite_asset` levanta a exceção
de propósito com `DEBUG=False`, em vez de renderizar uma página meio quebrada.

Variáveis de ambiente obrigatórias (veja `.env.example`):

| Variável | Obrigatória | Observação |
|---|---|---|
| `SECRET_KEY` | sim | `production.py` lê sem default e falha na inicialização se faltar |
| `ALLOWED_HOSTS` | sim | recusa lista vazia ou `*` em produção |
| `REDIS_URL` | recomendada | cache compartilhado; sem ela o rate limit vira por worker |
| `CSRF_TRUSTED_ORIGINS` | não | default: `https://` + cada host de `ALLOWED_HOSTS` |
| `VITE_DEV_SERVER_URL` | não | só em desenvolvimento |

```bash
DJANGO_SETTINGS_MODULE=config.settings.production gunicorn config.wsgi:application
```

---

## Testes e verificação

```bash
python manage.py check          # checagem do sistema Django
pytest                          # 239 testes, cobertura ~95%
npm run lint                    # eslint
npm run build                   # o build precisa passar
```

Para exercitar as settings de produção — que `manage.py check` **não** cobre,
porque ele nunca monta a cadeia de middleware:

```bash
SECRET_KEY=<50+ caracteres> ALLOWED_HOSTS=testserver \
DJANGO_SETTINGS_MODULE=config.settings.production \
python -c "import django; django.setup(); \
from django.test import Client; print(Client().get('/', secure=True).status_code)"
```

Deve imprimir `200`.

---

## Arquitetura

```
apps/
  core/            respostas, exceções, validadores, geração de schema, tag {% vite_asset %}
  app_fluids/      \
  app_materials/    |  cada um: urls, views (DRF), services (a física), tests
  app_chemistry/    |  sem models — o projeto é stateless, só cálculo
  app_physics/      |
  app_tribology/   /
config/settings/   base · development · production
frontend/src/
  pages/           um bundle por página (entry points do Vite)
  modules/shared/  cliente de API, helpers de UI, ciclo de vida do Three.js
  modules/fluids/  gráficos Plotly e cena 3D dos fluidos
templates/         base.html + um template por módulo
```

**Contrato da API.** Toda resposta usa o mesmo envelope
(`apps/core/responses.py`):

```json
{ "status": "success", "data": { ... } }
{ "status": "error", "code": "validation_error", "message": "...", "errors": { "campo": ["..."] } }
```

`errors` é omitido quando não há detalhe por campo. O cliente axios em
`frontend/src/modules/shared/api.js` desembrulha o envelope de sucesso, então
as páginas recebem `data` direto.

**Schema dirigido pelo servidor.** Cada módulo expõe `.../schema/`, gerado a
partir do próprio serializer DRF (`apps/core/schema.py`), para que limites e
presets do formulário não sejam duplicados no cliente.

**Bibliotecas 3D.** Three.js (r128) e Plotly (2.33) são carregados como
`<script>` clássicos a partir de `apps/core/static/core/vendor/`, **não** via
npm. O `three` do npm resolveria para 0.166 — 38 revisões à frente, incluindo a
redefinição de unidades de intensidade luminosa da r155 — e os controladores
foram escritos contra a versão vendorizada. Os bundles contêm apenas código da
aplicação e o axios.

---

## Contribuindo

Antes de abrir um PR, rode as quatro verificações da seção acima; o CI roda
exatamente as mesmas. Ao mexer em `services.py`, acompanhe a mudança com um
teste que fixe o valor esperado por um caminho independente (um cálculo à mão
no docstring, ou os grupos adimensionais recompostos) — vários defeitos deste
projeto sobreviveram porque os testes só comparavam tendências.

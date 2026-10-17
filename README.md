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
| **Materiais** | `/api/materials/` | Vigas Euler-Bernoulli — quatro casos de carga (pontual/uniforme, biapoiada/engastada) em forma fechada: deflexão, diagramas de momento e cortante, reações, tensão σ = M·c/I, fator de segurança e verificação de flecha (L/250, L/180 em balanço); seções retangular, circular ou I manual |
| **Química** | `/api/chemistry/` | Tabela periódica dos 118 elementos, átomo de Bohr 3D, simulador de ligações e estequiometria |
| **Física** | `/api/physics/` | Lançamento de projéteis com arrasto quadrático (DOP853 adaptativo com evento de impacto), altura de lançamento, gravidade e densidade do ar configuráveis (Terra, Lua, Marte…), velocidade terminal; eletromagnetismo: força de Lorentz (passo ajustado ao período ciclotrônico), polos magnéticos e transiente de motor CC (LSODA, carga passiva com travamento, balanço de potência) |
| **Tribologia** | `/api/tribology/` | Geometria de engrenagens retas (AGMA/ISO) e lubrificação elastohidrodinâmica de Dowson-Higginson |

### Painéis flutuantes

Em cada módulo, **Configuração** (⚙️), **Resultados** (📊) e **Vista 3D** (🎥)
são janelas flutuantes não-modais: ficam abertas junto com a simulação, que
continua visível e interativa enquanto os parâmetros mudam.

- Na posição padrão, o painel abre espaço para si e a simulação se ajusta ao
  lado. Se não houver largura para manter a simulação com pelo menos 600 px,
  o painel flutua por cima.
- Arraste pelo título para soltá-lo em qualquer ponto; um duplo clique no
  título o devolve à posição padrão. O canto inferior direito redimensiona e
  o botão **–** minimiza. **↺** (barra superior) restaura o layout inteiro.
- **Modo foco** (**⛶** ou **F**): esconde a barra lateral e o cabeçalho e
  estica a simulação; os indicadores do cabeçalho passam a aparecer sobre o
  canvas (também quando o cabeçalho sai da tela ao rolar).
- Atalhos: **C**, **R** e **V** abrem e fecham os painéis; **Esc** fecha o
  painel em foco.
- Estado aberto/fechado, posição e tamanho ficam salvos por página. Abaixo de
  768 px os painéis viram uma folha inferior, um de cada vez; arraste o título
  para 30 / 62 / 90 % da altura, ou para baixo para fechar.

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
pytest                          # 272 testes, cobertura ~95%
npm run lint                    # eslint
npm run build                   # o build precisa passar
npm run test:e2e                # testes no navegador (Playwright + Chrome instalado)
```

Os testes de navegador (`e2e/`) sobem o `runserver` sozinhos e usam o Google
Chrome da máquina (`channel: 'chrome'`), sem baixar navegadores. Com um
servidor já rodando na porta 8000 eles o reutilizam; no Windows com venv,
defina `E2E_SERVER_CMD=".venv/Scripts/python.exe manage.py runserver 127.0.0.1:8000 --noreload"`.

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
  main.js          entry carregado em toda página: styles/app.css + o "shell"
  styles/app.css   folha de estilos da aplicação (tokens, layout, painéis)
  pages/           um bundle por página (entry points do Vite)
  modules/shared/  painéis flutuantes, shell (foco, HUD, exportar), API, Three.js
  modules/fluids/  gráficos Plotly e cena 3D dos fluidos
templates/         base.html + um template por módulo
  partials/        camera_panel.html — controles da vista 3D (incluído por página)
e2e/               testes de navegador (Playwright)
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

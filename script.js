// 1. 初始化 WebGL 卫星地球
const world = Globe()
    (document.getElementById('globe-container'))
    .globeImageUrl('//unpkg.com/three-globe/example/img/earth-blue-marble.jpg') 
    .bumpImageUrl('//unpkg.com/three-globe/example/img/earth-topology.png')    
    .backgroundImageUrl('//unpkg.com/three-globe/example/img/night-sky.png')   
    .showAtmosphere(true)
    .atmosphereColor('#00ffaa')
    .atmosphereAltitude(0.15);

// 2. 交互控制与状态管理
const controls = world.controls();
controls.autoRotate = true; 
controls.autoRotateSpeed = 1.0; 

let interactTimeout;
let selectedCountryId = null; 
let partnerCountryIds = new Set(); 

// 新增：全局数据与时间轴状态
let globalTradeDataRaw = [];
let currentStartYear = 2010; 
let currentEndYear = 2020;   

function clearSelectionAndResume() {
    selectedCountryId = null;
    partnerCountryIds.clear(); 
    world.arcsData([]); 
    world.labelsData([]); 
    world.polygonsData([...world.polygonsData()]); 
    d3.select("#tooltip-container").style("display", "none");
    d3.select("#side-panel").classed("hidden", true);
    controls.autoRotate = true; 
}

function resetAutoRotateTimer() {
    clearTimeout(interactTimeout);
    interactTimeout = setTimeout(() => { clearSelectionAndResume(); }, 15000); 
}

controls.addEventListener('start', () => { controls.autoRotate = false; clearTimeout(interactTimeout); });
controls.addEventListener('end', resetAutoRotateTimer);
world.onGlobeClick(() => { clearSelectionAndResume(); });

// 终极去乱码函数：暴力清除所有特殊拉丁字符 (解决 Bras?lia 等问号问题)
function sanitizeName(str) {
    if (!str) return "";
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x00-\x7F]/g, "");
}

// 3. 数据过滤配置：不再过滤 2019，而是保留年份字段
const rowConverter = function(d) {
    if (d.tradeflow_baci !== "" && d.tradeflow_baci > 0) {
        return {
            year: parseInt(d.year, 10), // 保留年份，用于滑动条过滤
            src_id: parseInt(d.iso3num_o, 10),
            dst_id: parseInt(d.iso3num_d, 10),
            flow: parseFloat(d.tradeflow_baci)
        };
    }
    return null;
};

const formatFlow = d3.format("$.2s"); 

// ==========================================
// 加载动画引擎
// ==========================================
let loadingProgress = 0;
const progressText = document.getElementById('progress-text');
const statusText = document.getElementById('loading-status-text');
const overlay = document.getElementById('loading-overlay');

const loadingInterval = setInterval(() => {
    loadingProgress += Math.random() * 18;
    if (loadingProgress > 94) loadingProgress = 94; 
    progressText.innerText = `${Math.floor(loadingProgress)}%`;
    
    if (loadingProgress > 10 && loadingProgress <= 40) {
        statusText.innerText = "CONNECTING TO PUBLIC WEB API...";
    } else if (loadingProgress > 40 && loadingProgress <= 70) {
        statusText.innerText = "FETCHING CEPII BACI TRADE DATA...";
    } else if (loadingProgress > 70) {
        statusText.innerText = "AUTO-ENCODING GLOBAL CAPITALS & FLAGS...";
    }
}, 300);

// ==========================================
// 核心：全自动并发加载
// ==========================================
Promise.all([
    d3.json('DATA/countries-50m.json'),
    d3.csv('DATA/Gravity_2000_2020.csv', rowConverter), // 使用你 72 年的新文件
    d3.json('https://restcountries.com/v3.1/all?fields=ccn3,capital,capitalInfo,cca2').catch(err => []),
    d3.json('https://unpkg.com/three/examples/fonts/helvetiker_bold.typeface.json')
]).then(([topologyData, tradeDataRaw, restCountriesData, boldFont]) => {
    
    clearInterval(loadingInterval);
    progressText.innerText = '100%';
    statusText.innerText = "SYSTEM READY. LAUNCHING...";
    statusText.style.color = "#ffaa00"; 
    
    setTimeout(() => {
        overlay.style.opacity = '0';
        setTimeout(() => {
            overlay.style.visibility = 'hidden';
            overlay.style.display = 'none';
        }, 800); 
    }, 600);

    // 将 72 年的原始数据存入全局变量
    globalTradeDataRaw = tradeDataRaw.filter(d => d !== null);

    const dynamicCapitalsDB = {};
    if (restCountriesData && restCountriesData.length > 0) {
        restCountriesData.forEach(country => {
            if (country.ccn3 && country.capitalInfo && country.capitalInfo.latlng && country.capital && country.capital.length > 0) {
                const rawCapitalName = country.capital[0];
                const cleanCapitalName = sanitizeName(rawCapitalName); // 使用去乱码函数

                dynamicCapitalsDB[parseInt(country.ccn3, 10)] = {
                    name: cleanCapitalName,
                    lat: country.capitalInfo.latlng[0],
                    lng: country.capitalInfo.latlng[1],
                    cca2: country.cca2 ? country.cca2.toLowerCase() : null 
                };
            }
        });
    }

    const countries = topojson.feature(topologyData, topologyData.objects.countries).features;
    const coordMap = {};
    
    countries.forEach(feature => {
        const numericId = parseInt(feature.id, 10);
        if (!isNaN(numericId)) {
            if (dynamicCapitalsDB[numericId]) {
                coordMap[numericId] = { 
                    lng: dynamicCapitalsDB[numericId].lng, 
                    lat: dynamicCapitalsDB[numericId].lat, 
                    name: feature.properties.name,
                    capitalName: dynamicCapitalsDB[numericId].name,
                    cca2: dynamicCapitalsDB[numericId].cca2 
                };
            } else {
                const centroid = d3.geoCentroid(feature);
                coordMap[numericId] = { 
                    lng: centroid[0], 
                    lat: centroid[1], 
                    name: feature.properties.name,
                    capitalName: "Center",
                    cca2: null
                };
            }
        }
    });

    // ==========================================
    // 新增：动态数据计算引擎 (替代原来的静态遍历)
    // ==========================================
    let tradeNetwork = {};
    let countryExportTotals = {};

    function updateTradeData() {
        tradeNetwork = {};
        countryExportTotals = {};

        // 1. 根据滑动条过滤出对应年份
        const filteredData = globalTradeDataRaw.filter(d => d.year >= currentStartYear && d.year <= currentEndYear);
        
        // 2. 累加所选年份的总额
        filteredData.forEach(route => {
            if (!tradeNetwork[route.src_id]) { tradeNetwork[route.src_id] = {}; }
            if (!tradeNetwork[route.src_id][route.dst_id]) {
                tradeNetwork[route.src_id][route.dst_id] = { dst_id: route.dst_id, flow: 0 };
            }
            tradeNetwork[route.src_id][route.dst_id].flow += route.flow;

            if (!countryExportTotals[route.src_id]) { countryExportTotals[route.src_id] = 0; }
            countryExportTotals[route.src_id] += route.flow;
        });

        // 将内部对象转回数组格式，保证下方原生逻辑不报错
        for (let src in tradeNetwork) {
            tradeNetwork[src] = Object.values(tradeNetwork[src]);
        }
    }

    // 初次启动加载数据
    updateTradeData();

    // ==========================================
    // 绑定滑动条事件 (无需改动原生 HTML)
    // ==========================================
    const slider = document.getElementById('year-slider');
    const yearDisplay = document.getElementById('year-display');
    if (slider) {
        noUiSlider.create(slider, {
            start: [2010, 2020],
            connect: true,
            step: 1,
            range: { 'min': 2000, 'max': 2020 }
        });
        
        slider.noUiSlider.on('update', function (values) {
            currentStartYear = parseInt(values[0]);
            currentEndYear = parseInt(values[1]);
            yearDisplay.innerText = (currentStartYear === currentEndYear) ? currentStartYear : `${currentStartYear} - ${currentEndYear}`;
        });
        
        slider.noUiSlider.on('change', function () {
            updateTradeData(); // 更新内存里的贸易额
            world.polygonsData([...world.polygonsData()]); // 强制刷新地球提示框
            if (selectedCountryId) {
                renderDashboard(selectedCountryId); // 如果选中了国家，更新面板
            }
        });
    }

    const tooltipContainer = d3.select("#tooltip-container");
    const sidePanel = d3.select("#side-panel");

    world.labelsData([])
         .labelLat(d => d.lat)
         .labelLng(d => d.lng)
         .labelText(d => d.text)
         .labelSize(d => d.size)
         .labelDotRadius(d => d.dotRadius)
         .labelColor(d => d.color)
         .labelTypeFace(boldFont)
         .labelResolution(2);

    // ==========================================
    // 地球渲染与交互：保留原始结构，只更新文字提示
    // ==========================================
    world.polygonsData(countries)
        .polygonCapColor(d => {
            const numericId = parseInt(d.id, 10);
            if (numericId === selectedCountryId) return 'rgba(0, 255, 170, 0.4)';
            if (partnerCountryIds.has(numericId)) return 'rgba(255, 170, 0, 0.4)';
            return 'rgba(0, 0, 0, 0)';
        }) 
        .polygonStrokeColor(d => {
            const numericId = parseInt(d.id, 10);
            if (numericId === selectedCountryId) return 'rgba(0, 255, 170, 1)';
            if (partnerCountryIds.has(numericId)) return 'rgba(255, 170, 0, 1)';
            return 'rgba(0, 255, 170, 0.2)'; 
        }) 
        .polygonSideColor(() => 'rgba(0, 0, 0, 0)')
        
        .onPolygonHover(hoverD => {
            world
                .polygonStrokeColor(d => {
                    const numericId = parseInt(d.id, 10);
                    if (numericId === selectedCountryId) return 'rgba(0, 255, 170, 1)';
                    if (partnerCountryIds.has(numericId)) return 'rgba(255, 170, 0, 1)';
                    if (d === hoverD) return 'rgba(255, 255, 255, 1)'; 
                    return 'rgba(0, 255, 170, 0.2)';
                })
                .polygonCapColor(d => {
                    const numericId = parseInt(d.id, 10);
                    if (numericId === selectedCountryId) return 'rgba(0, 255, 170, 0.4)';
                    if (partnerCountryIds.has(numericId)) return 'rgba(255, 170, 0, 0.4)';
                    if (d === hoverD) return 'rgba(255, 255, 255, 0.15)'; 
                    return 'rgba(0, 0, 0, 0)';
                });

            if (hoverD) {
                const hoverId = parseInt(hoverD.id, 10);
                const cData = coordMap[hoverId];
                const countryName = cData ? cData.name : hoverD.properties.name;
                const capString = (cData && cData.capitalName !== "Center") ? ` (${cData.capitalName})` : "";
                const flagHtml = (cData && cData.cca2) ? `<img src="https://flagcdn.com/w40/${cData.cca2}.png" class="tooltip-flag" alt="flag">` : '';

                if (partnerCountryIds.has(hoverId)) {
                    tooltipContainer
                        .style("display", "block")
                        .html(`
                            <div class="tooltip-title">${flagHtml}${countryName}${capString}</div>
                            <div class="tooltip-detail">Role: <span class="trade-highlight">Top Export Destination</span></div>
                        `);
                } else {
                    const totalExport = countryExportTotals[hoverId] ? formatFlow(countryExportTotals[hoverId] * 1000) : "$0";
                    const yearLabel = (currentStartYear === currentEndYear) ? currentStartYear : `${currentStartYear}-${currentEndYear}`;
                    tooltipContainer
                        .style("display", "block")
                        .html(`
                            <div class="tooltip-title">${flagHtml}${countryName}${capString}</div>
                            <div class="tooltip-detail">${yearLabel} Exports: <span class="tooltip-highlight">${totalExport}</span></div>
                            <div class="tooltip-detail" style="font-size: 12px; margin-top:5px; color:#888;">(Click to lock & view details)</div>
                        `);
                }
            } else {
                tooltipContainer.style("display", "none");
            }
        })
        .onPolygonClick(d => {
            renderDashboard(parseInt(d.id, 10)); // 提取原代码，适配滑动条自动刷新
        });

    // 独立出来的右侧面板与飞线渲染函数（无损提取你的原代码）
    function renderDashboard(clickId) {
        const center = coordMap[clickId];
        if (!center) return;

        controls.autoRotate = false;
        clearTimeout(interactTimeout);
        resetAutoRotateTimer();

        world.pointOfView({ lat: center.lat, lng: center.lng, altitude: 1.4 }, 1200);

        const exportsFromHere = tradeNetwork[clickId] || [];
        const totalExportVol = countryExportTotals[clickId] || 0;

        const topPartners = exportsFromHere
            .sort((a, b) => b.flow - a.flow)
            .slice(0, 10);

        selectedCountryId = clickId;
        partnerCountryIds.clear();
        topPartners.forEach(p => partnerCountryIds.add(p.dst_id));

        world.polygonsData([...world.polygonsData()]);

        const flagHtml = (center.cca2) ? `<img src="https://flagcdn.com/w80/${center.cca2}.png" class="panel-flag" alt="flag">` : '';
        const yearLabel = (currentStartYear === currentEndYear) ? currentStartYear : `${currentStartYear}-${currentEndYear}`;

        let panelHtml = `
            <div class="panel-header">
                ${flagHtml}
                <h2 class="panel-title">${coordMap[clickId].name}</h2>
            </div>
            <div class="panel-stat"><span>Global Export Destinations</span> <span class="trade-highlight">${exportsFromHere.length}</span></div>
            <div class="panel-stat"><span>${yearLabel} Export Vol.</span> <span class="tooltip-highlight">${formatFlow(totalExportVol * 1000)}</span></div>
            <h3 class="panel-subtitle">Top Export Destinations</h3>
            <ul class="panel-list">
        `;

        topPartners.forEach(p => {
             const partnerData = coordMap[p.dst_id];
             const pName = partnerData ? partnerData.name : "Unknown";
             const pFlagHtml = (partnerData && partnerData.cca2) ? `<img src="https://flagcdn.com/w40/${partnerData.cca2}.png" class="p-flag" alt="flag">` : '';
             panelHtml += `<li><span class="p-name">${pFlagHtml}${pName}</span> <span class="p-val">${formatFlow(p.flow * 1000)}</span></li>`;
        });

        panelHtml += `</ul>`;
        sidePanel.html(panelHtml).classed("hidden", false);

        const maxFlow = topPartners.length > 0 ? topPartners[0].flow : 1;
        const labelsArray = [];

        if (center.capitalName !== "Center") {
            labelsArray.push({
                lat: center.lat, lng: center.lng, text: center.capitalName,
                size: 0.8, dotRadius: 0.25, color: 'rgba(0, 255, 170, 1)'
            });
        }

        const arcData = topPartners.map(route => {
            const dst = coordMap[route.dst_id];
            if (dst) {
                const normalizedWeight = route.flow / maxFlow; 
                if (dst.capitalName !== "Center") {
                    labelsArray.push({
                        lat: dst.lat, lng: dst.lng, text: dst.capitalName,
                        size: 0.5, dotRadius: 0.15, color: 'rgba(255, 170, 0, 1)'
                    });
                }

                return {
                    srcName: coordMap[clickId].name, dstName: dst.name, rawFlow: route.flow,
                    startLat: center.lat, startLng: center.lng, endLat: dst.lat, endLng: dst.lng,
                    altitude: Math.max(0.2, normalizedWeight * 0.8),
                    color: ['rgba(255, 170, 0, 0.1)', 'rgba(255, 170, 0, 1)'], 
                    stroke: Math.max(0.3, normalizedWeight * 2)
                };
            }
            return null;
        }).filter(d => d !== null);

        world.labelsData(labelsArray);
        setTimeout(() => { world.arcsData(arcData); }, 800);
    }

    world.arcsData([]) 
        .arcStartLat(d => d.startLat)
        .arcStartLng(d => d.startLng)
        .arcEndLat(d => d.endLat)
        .arcEndLng(d => d.endLng)
        .arcColor(d => d.color)
        .arcAltitude(d => d.altitude) 
        .arcStroke(d => d.stroke)     
        .arcDashLength(0.85)           
        .arcDashGap(0.5)                
        .arcDashInitialGap(() => Math.random() * 5) 
        .arcDashAnimateTime(3000)
        .onArcHover(hoverD => {
            if (hoverD) {
                const formattedRaw = formatFlow(hoverD.rawFlow * 1000); 
                tooltipContainer
                    .style("display", "block")
                    .html(`
                        <div class="tooltip-title">${hoverD.srcName} ➡️ ${hoverD.dstName}</div>
                        <div class="tooltip-detail">Trade Volume: <span class="trade-highlight">${formattedRaw}</span></div>
                    `);
            }
        });

}).catch(err => {
    console.error("Error loading files!", err);
    clearInterval(loadingInterval);
    progressText.innerText = "ERR";
    progressText.style.color = "#ff4444";
    statusText.innerText = "CRITICAL DATA FAILURE";
});
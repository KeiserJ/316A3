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

// 重置函数：清空所有状态、飞线和全息标签
function clearSelectionAndResume() {
    selectedCountryId = null;
    partnerCountryIds.clear(); 
    world.arcsData([]); 
    world.labelsData([]); // 清空悬浮首都名称
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

// 点击海洋/空白处重置
world.onGlobeClick(() => { clearSelectionAndResume(); });

// 3. 数据处理配置：只保留 2019 年真实数据
const rowConverter = function(d) {
    if (d.year === "2019" && d.tradeflow_baci !== "" && d.tradeflow_baci > 0) {
        return {
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
        statusText.innerText = "AUTO-ENCODING GLOBAL CAPITALS...";
    }
}, 300);

// ==========================================
// 核心：全自动并发加载 (带降级保护 + 3D字体JSON)
// ==========================================
Promise.all([
    d3.json('DATA/countries-50m.json'),
    d3.csv('DATA/Gravity_V202211.csv', rowConverter),
    // 加入降级保护，防止 API 失败导致国境线崩溃
    d3.json('https://restcountries.com/v3.1/all?fields=ccn3,capital,capitalInfo').catch(err => []),
    // 👇 关键修复：正确加载 Three.js 格式的加粗无衬线字体文件 👇
    d3.json('https://unpkg.com/three/examples/fonts/helvetiker_bold.typeface.json')
]).then(([topologyData, tradeDataRaw, restCountriesData, boldFont]) => {
    
    // 数据加载完毕，直奔 100%
    clearInterval(loadingInterval);
    progressText.innerText = '100%';
    statusText.innerText = "SYSTEM READY. LAUNCHING...";
    statusText.style.color = "#ffaa00"; 
    
    // 遮罩淡出动画
    setTimeout(() => {
        overlay.style.opacity = '0';
        setTimeout(() => {
            overlay.style.visibility = 'hidden';
            overlay.style.display = 'none';
        }, 800); 
    }, 600);

    // 1. 自动解析 API 数据，构建全球动态首都库
    const dynamicCapitalsDB = {};
    if (restCountriesData && restCountriesData.length > 0) {
        restCountriesData.forEach(country => {
            if (country.ccn3 && country.capitalInfo && country.capitalInfo.latlng && country.capital && country.capital.length > 0) {
                
                const rawCapitalName = country.capital[0];
                const cleanCapitalName = rawCapitalName.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

                dynamicCapitalsDB[parseInt(country.ccn3, 10)] = {
                    name: cleanCapitalName,
                    lat: country.capitalInfo.latlng[0],
                    lng: country.capitalInfo.latlng[1]
                };
            }
        });
    }

    const tradeData = tradeDataRaw.filter(d => d !== null);
    const countries = topojson.feature(topologyData, topologyData.objects.countries).features;
    const coordMap = {};
    
    // 2. 将地图 Polygon 与我们的动态首都库进行智能合并
    countries.forEach(feature => {
        const numericId = parseInt(feature.id, 10);
        if (!isNaN(numericId)) {
            if (dynamicCapitalsDB[numericId]) {
                coordMap[numericId] = { 
                    lng: dynamicCapitalsDB[numericId].lng, 
                    lat: dynamicCapitalsDB[numericId].lat, 
                    name: feature.properties.name,
                    capitalName: dynamicCapitalsDB[numericId].name 
                };
            } else {
                const centroid = d3.geoCentroid(feature);
                coordMap[numericId] = { 
                    lng: centroid[0], 
                    lat: centroid[1], 
                    name: feature.properties.name,
                    capitalName: "Center" 
                };
            }
        }
    });

    const tradeNetwork = {};
    const countryExportTotals = {};

    tradeData.forEach(route => {
        if (!tradeNetwork[route.src_id]) { tradeNetwork[route.src_id] = []; }
        tradeNetwork[route.src_id].push(route);

        if (!countryExportTotals[route.src_id]) { countryExportTotals[route.src_id] = 0; }
        countryExportTotals[route.src_id] += route.flow;
    });

    const tooltipContainer = d3.select("#tooltip-container");
    const sidePanel = d3.select("#side-panel");

    // ==========================================
    // 配置 WebGL 全息首都标签层
    // ==========================================
    world.labelsData([])
         .labelLat(d => d.lat)
         .labelLng(d => d.lng)
         .labelText(d => d.text)
         .labelSize(d => d.size)
         .labelDotRadius(d => d.dotRadius)
         .labelColor(d => d.color)
         // 👇 唯一正确的 WebGL 字体修改法：应用我们上方解析好的 JSON 字体 👇
         .labelTypeFace(boldFont)
         .labelResolution(2);

    // ==========================================
    // 绘制多边形与交互细节
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
                
                if (partnerCountryIds.has(hoverId)) {
                    tooltipContainer
                        .style("display", "block")
                        .html(`
                            <div class="tooltip-title">${countryName}${capString}</div>
                            <div class="tooltip-detail">Role: <span class="trade-highlight">Trade Partner</span></div>
                        `);
                } else {
                    const totalExport = countryExportTotals[hoverId] ? formatFlow(countryExportTotals[hoverId] * 1000) : "$0";
                    tooltipContainer
                        .style("display", "block")
                        .html(`
                            <div class="tooltip-title">${countryName}${capString}</div>
                            <div class="tooltip-detail">2019 Total Exports: <span class="tooltip-highlight">${totalExport}</span></div>
                            <div class="tooltip-detail" style="font-size: 12px; margin-top:5px; color:#888;">(Click to lock & view details)</div>
                        `);
                }
            } else {
                tooltipContainer.style("display", "none");
            }
        })
        
        .onPolygonClick(d => {
            const clickId = parseInt(d.id, 10);
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
                .slice(0, 20);

            selectedCountryId = clickId;
            partnerCountryIds.clear();
            topPartners.forEach(p => partnerCountryIds.add(p.dst_id));

            world.polygonsData([...world.polygonsData()]);

            let panelHtml = `
                <h2 class="panel-title">${coordMap[clickId].name}</h2>
                <div class="panel-stat"><span>Global Partners</span> <span class="trade-highlight">${exportsFromHere.length}</span></div>
                <div class="panel-stat"><span>Total Export Vol.</span> <span class="tooltip-highlight">${formatFlow(totalExportVol * 1000)}</span></div>
                <h3 class="panel-subtitle">Top Trade Partners</h3>
                <ul class="panel-list">
            `;

            topPartners.slice(0, 10).forEach(p => {
                 let pName = coordMap[p.dst_id] ? coordMap[p.dst_id].name : "Unknown";
                 panelHtml += `<li><span class="p-name">${pName}</span> <span class="p-val">${formatFlow(p.flow * 1000)}</span></li>`;
            });

            panelHtml += `</ul>`;
            sidePanel.html(panelHtml).classed("hidden", false);

            const maxFlow = topPartners.length > 0 ? topPartners[0].flow : 1;
            
            const labelsArray = [];

            // 你的设定保留：原点首都文字大小为 0.8，圆点为 0.25
            if (center.capitalName !== "Center") {
                labelsArray.push({
                    lat: center.lat,
                    lng: center.lng,
                    text: center.capitalName,
                    size: 0.8,
                    dotRadius: 0.25,
                    color: 'rgba(0, 255, 170, 1)'
                });
            }

            const arcData = topPartners.map(route => {
                const dst = coordMap[route.dst_id];
                if (dst) {
                    const normalizedWeight = route.flow / maxFlow; 
                    
                    // 你的设定保留：目标点首都文字大小为 0.5，圆点为 0.15
                    if (dst.capitalName !== "Center") {
                        labelsArray.push({
                            lat: dst.lat,
                            lng: dst.lng,
                            text: dst.capitalName,
                            size: 0.5,
                            dotRadius: 0.15,
                            color: 'rgba(255, 170, 0, 1)'
                        });
                    }

                    return {
                        srcName: coordMap[clickId].name, 
                        dstName: dst.name,
                        rawFlow: route.flow,
                        startLat: center.lat, startLng: center.lng,
                        endLat: dst.lat, endLng: dst.lng,
                        altitude: Math.max(0.2, normalizedWeight * 0.8),
                        color: ['rgba(255, 170, 0, 0.1)', 'rgba(255, 170, 0, 1)'], 
                        stroke: Math.max(0.3, normalizedWeight * 2)
                    };
                }
                return null;
            }).filter(d => d !== null);

            world.labelsData(labelsArray);

            setTimeout(() => {
                world.arcsData(arcData);
            }, 800);
        });

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